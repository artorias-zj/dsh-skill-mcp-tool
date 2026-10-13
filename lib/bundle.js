/**
 * dsh-skill-mcp-tool —— 配置打包（导出 / 导入）。
 *
 * 目标：把本插件管理过的 **Skills + MCP 服务器 + Git 来源记录** 打包成一个文件，
 * 换电脑时导入即可恢复工作环境。
 *
 * 设计取向（都有理由，改动前请先读）：
 *
 * 1. **技能有「配方」与「内容」两种载荷。**
 *    本插件装的技能多半来自 Git，重新克隆一次就能精确还原（还带提交号），
 *    所以只存仓库地址 + 提交 + 落盘形态，几 KB 即可描述整套环境。
 *    但本地手写/手装的技能没有上游可拉，必须连文件一起带走。两种都支持，
 *    导出时由用户选；导入时按每条技能自带的 `origin` 决定走哪条路径。
 *
 * 2. **二进制文件用 base64，文本用 utf8。** 判定方式是「能否无损往返 UTF-8」，
 *    不靠扩展名白名单 —— 白名单总会漏。技能目录里常见图片/字体，base64 会
 *    膨胀约 33%，因此导出结果里会如实报告体积。
 *
 * 3. **密钥默认不写进文件。** 插件的常态是「密钥从不回传浏览器」；导出会打破
 *    这条边界，所以必须显式勾选，且未勾选时只写键名（导入后界面能提示「这里
 *    需要一个令牌」，但不会替你编造值）。
 *
 * 4. **导入先预检再执行。** `planImport` 只读不写，产出「将要做什么」；
 *    用户确认后才 `applyImport`。换电脑时最怕的是「导入了一半」，
 *    因此计划里对每个条目给出明确动作与原因。
 *
 * @module dsh-skill-mcp-tool/bundle
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { COPY_EXCLUDES } from "./git-source.js";

/** 文件标识：既是格式版本也是「这是本插件的导出」判据。 */
export const BUNDLE_KIND = "dsh-skill-mcp-tool/settings";
/** 当前格式版本。导入时只接受 <= 本值。 */
export const BUNDLE_VERSION = 1;
/** 单个文件上限（二进制资源偶尔会很大，超过就跳过并如实报告）。 */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;

/** 载荷模式：`recipe` 只存来源配方，`full` 连文件内容一起存。 */
export const PAYLOAD_MODES = { recipe: "recipe", full: "full" };

/**
 * 判断缓冲区是否可安全按 UTF-8 文本保存。
 * 判据：不含 NUL 字节，且「解码再编码」与原文逐字节相同（排除非法序列）。
 */
function isTextBuffer(buffer) {
	if (buffer.includes(0)) return false;
	const decoded = buffer.toString("utf8");
	return Buffer.from(decoded, "utf8").equals(buffer);
}

/**
 * 递归读取一个技能目录，产出可序列化的文件清单。
 *
 * 与安装路径共用同一份排除表（`.git` / `node_modules` 等）—— 打包时同样不该
 * 把仓库元数据带走，否则导出文件白白膨胀数 MB。
 *
 * @param rootDir 技能目录（目录束）或其所在目录（平铺单文件传文件所在目录 + 文件名）
 * @param options.singleFile 平铺单文件：只打包这一个文件（相对技能根命名）
 * @returns {{files: Array<{path,text?|base64?}>, bytes: number, skipped: Array<{path,reason}>}}
 */
export async function readSkillFiles(rootDir, options = {}) {
	const files = [];
	const skipped = [];
	let bytes = 0;

	const push = async (absolute, relativePath) => {
		let buffer;
		try {
			buffer = await readFile(absolute);
		} catch (error) {
			skipped.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (buffer.length > MAX_FILE_BYTES) {
			skipped.push({ path: relativePath, reason: `超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB` });
			return;
		}
		bytes += buffer.length;
		files.push(isTextBuffer(buffer) ? { path: relativePath, text: buffer.toString("utf8") } : { path: relativePath, base64: buffer.toString("base64") });
	};

	if (typeof options.singleFile === "string" && options.singleFile !== "") {
		await push(options.singleFile, options.singleFile.split(/[/\\]/).pop());
		return { files, bytes, skipped };
	}

	const walk = async (dir) => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			skipped.push({ path: relative(rootDir, dir), reason: error instanceof Error ? error.message : String(error) });
			return;
		}
		for (const entry of entries) {
			if (COPY_EXCLUDES.has(entry.name)) {
				skipped.push({ path: relative(rootDir, join(dir, entry.name)), reason: "仓库元数据 / 依赖目录" });
				continue;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			// 符号链接等其它类型跳过：内容可能指向目录外，打包它等于泄露无关文件。
			if (!entry.isFile()) {
				skipped.push({ path: relative(rootDir, full), reason: "非普通文件（符号链接等）" });
				continue;
			}
			await push(full, relative(rootDir, full).split(sep).join("/"));
		}
	};

	await walk(rootDir);
	// 稳定的输出顺序：同一份配置重复导出应得到同样排列，便于 diff 与比对。
	files.sort((a, b) => a.path.localeCompare(b.path, "en"));
	skipped.sort((a, b) => a.path.localeCompare(b.path, "en"));
	return { files, bytes, skipped };
}

/**
 * 组装导出包（纯函数，便于测试）。
 *
 * @param input.skills  技能条目（已含 origin / enabled / kind）
 * @param input.sources 来源记录（原样带走，导入后「检查更新」立即可用）
 * @param input.mcp     `{ servers: [...] }`，服务器对象里的 `env` / `headers`
 *                      是否含明文由调用方决定（按 includeSecrets 过滤）
 * @param input.options `{ skills: "recipe"|"full", includeSecrets: boolean }`
 * @param input.generator `{ plugin, version }`
 */
export function buildBundle(input) {
	return {
		kind: BUNDLE_KIND,
		version: BUNDLE_VERSION,
		exportedAt: new Date().toISOString(),
		generator: input.generator ?? {},
		options: {
			skills: input.options?.skills === PAYLOAD_MODES.full ? PAYLOAD_MODES.full : PAYLOAD_MODES.recipe,
			includeSecrets: input.options?.includeSecrets === true
		},
		sources: input.sources ?? [],
		skills: input.skills ?? [],
		mcp: { servers: input.mcp?.servers ?? [] }
	};
}

/**
 * 校验并归一化一个导入对象。
 * @returns {{ok: boolean, errors: string[], warnings: string[], bundle?: object, stats?: object}}
 */
export function validateBundle(raw) {
	const errors = [];
	const warnings = [];
	const reject = (message) => {
		errors.push(message);
		return { ok: false, errors, warnings };
	};

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return reject("文件内容不是对象");
	if (raw.kind !== BUNDLE_KIND) return reject(`不是本插件的配置文件（kind=${JSON.stringify(raw.kind)}）`);
	const version = Number(raw.version);
	if (!Number.isInteger(version) || version < 1) return reject(`版本号无效：${JSON.stringify(raw.version)}`);
	if (version > BUNDLE_VERSION) {
		return reject(`配置来自更新的插件版本（文件 v${version}，本插件支持到 v${BUNDLE_VERSION}），请先升级插件`);
	}
	if (!Array.isArray(raw.skills)) return reject("skills 字段必须是数组");
	if (raw.mcp === null || typeof raw.mcp !== "object" || !Array.isArray(raw.mcp?.servers)) {
		return reject("mcp.servers 字段必须是数组");
	}

	const skills = [];
	for (const item of raw.skills) {
		const name = typeof item?.name === "string" ? item.name : "";
		if (name === "") {
			warnings.push("跳过一个没有名字的技能条目");
			continue;
		}
		const mode = item.payload === "full" ? "full" : "recipe";
		if (mode === "full" && !Array.isArray(item.files)) {
			warnings.push(`技能 "${name}" 声明为完整内容，但没有 files 字段，已跳过`);
			continue;
		}
		if (mode === "recipe" && (item.origin === null || typeof item.origin !== "object" || typeof item.origin.url !== "string")) {
			warnings.push(`技能 "${name}" 既没有文件内容也没有可用的 Git 来源，已跳过`);
			continue;
		}
		skills.push({
			name,
			kind: item.kind === "flat" ? "flat" : "bundle",
			enabled: item.enabled !== false,
			description: typeof item.description === "string" ? item.description : "",
			payload: mode,
			origin: item.origin ?? undefined,
			files: mode === "full" ? item.files : undefined,
			skipped: Array.isArray(item.skipped) ? item.skipped : []
		});
	}

	const servers = [];
	for (const item of raw.mcp.servers) {
		const serverName = typeof item?.serverName === "string" ? item.serverName : "";
		if (serverName === "") {
			warnings.push("跳过一个没有名字的 MCP 服务器条目");
			continue;
		}
		servers.push({ ...item, serverName });
	}

	const sources = Array.isArray(raw.sources) ? raw.sources.filter((s) => typeof s?.label === "string" && s.label !== "") : [];
	if (Array.isArray(raw.sources) && sources.length !== raw.sources.length) warnings.push("来源记录里有缺 label 的条目，已忽略");

	const bundle = {
		kind: BUNDLE_KIND,
		version,
		exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : undefined,
		generator: raw.generator ?? {},
		options: {
			skills: raw.options?.skills === PAYLOAD_MODES.full ? PAYLOAD_MODES.full : PAYLOAD_MODES.recipe,
			includeSecrets: raw.options?.includeSecrets === true
		},
		sources,
		skills,
		mcp: { servers }
	};

	// 体积与构成摘要：导入前让用户看清「要还原什么、有多大」。
	const bytes = skills.reduce(
		(sum, skill) => sum + (skill.files ?? []).reduce((inner, file) => inner + (file.base64 ? Math.floor(file.base64.length * 3 / 4) : Buffer.byteLength(file.text ?? "", "utf8")), 0),
		0
	);
	const withSecrets = servers.filter((s) => s.hasSecrets === true).length;
	if (withSecrets > 0) warnings.push(`文件内含 ${withSecrets} 个服务器的明文密钥，请妥善保管`);

	return {
		ok: true,
		errors,
		warnings,
		bundle,
		stats: {
			skills: skills.length,
			recipeSkills: skills.filter((s) => s.payload === "recipe").length,
			fullSkills: skills.filter((s) => s.payload === "full").length,
			servers: servers.length,
			sources: sources.length,
			bytes,
			includeSecrets: bundle.options.includeSecrets
		}
	};
}

/** 解析文本形式的导入包。 */
export function parseBundle(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`], warnings: [] };
	}
	return validateBundle(raw);
}

/**
 * 把技能文件写到一个目录下。
 * 写入前会建好父目录；返回实际写出的文件数。
 */
export async function writeSkillFiles(targetDir, files) {
	let written = 0;
	for (const file of files) {
		if (typeof file?.path !== "string" || file.path === "") continue;
		// 路径穿越防护：只允许相对路径，且不得逃出目标目录。
		const normalized = file.path.replace(/\\/g, "/");
		if (normalized.startsWith("/") || normalized.split("/").includes("..")) continue;
		const destination = join(targetDir, ...normalized.split("/"));
		if (!destination.startsWith(targetDir)) continue;
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, file.base64 !== undefined ? Buffer.from(file.base64, "base64") : String(file.text ?? ""), file.base64 !== undefined ? undefined : "utf8");
		written++;
	}
	return written;
}
