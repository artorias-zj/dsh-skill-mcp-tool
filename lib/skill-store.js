/**
 * dsh-skill-mcp-tool —— Skills 文件系统层。
 *
 * DSH 的 skill 来自两类来源：
 *   1. **文件技能**（官方 `@deepseek-ai/dsh-skill-filesystem` 提供方扫描的根目录）；
 *   2. **插件自带技能**（其他插件用 `ctx.skills.register()` 注册，没有文件）。
 *
 * 本模块只负责第 1 类的发现与增删改；第 2 类在网关里以只读方式列出。
 *
 * 技能布局（与官方提供方一致，一层发现）：
 *   - 目录束：`<root>/<name>/SKILL.md`
 *   - 平铺：  `<root>/<name>.md`
 *
 * **停用 = 改名加 `.disabled` 后缀**（`SKILL.md` → `SKILL.md.disabled`，
 * `<name>.md` → `<name>.md.disabled`）。官方提供方只认精确的 `SKILL.md` /
 * `*.md`，改名后条目自然从注册表消失，而文件内容与资源目录完整保留 ——
 * 这是无损、可逆且不需要额外状态的停用方式。配合提供方的 watcher，
 * 改名后下一次目录刷新即生效（热加载），无需重启。
 *
 * @module dsh-skill-mcp-tool/skill-store
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** 停用后缀。 */
export const DISABLED_SUFFIX = ".disabled";
/** 递归扫描跳过的目录名。 */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn"]);
/** 递归深度上限（防御符号链接环）。 */
const MAX_DEPTH = 8;
/** skill 名约束，与官方一致。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 路径是否存在。 */
export async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** 沿父目录向上找最近的 `.git`，作为项目根；找不到回退 cwd。 */
export async function findProjectRoot(cwd) {
	let current = resolve(cwd);
	for (let depth = 0; depth < 40; depth++) {
		if (await pathExists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return resolve(cwd);
}

/**
 * 解析 skill 根目录列表，顺序即发现优先级（越靠前越先命中），与官方 rank 一致：
 * 项目 `.dsh`(100) > 项目 `.agents`(200) > 用户 `.dsh`(400) > 用户 `.agents`(500)。
 * 解析后指向同一目录的根会去重，保留优先级更高的那个。
 */
export async function buildRoots(cwd, options = {}) {
	const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const agentsHome = options.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents");
	const roots = [];
	const seen = new Set();
	const push = (path, source, rank, projectRoot) => {
		const normalized = resolve(path);
		const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
		if (seen.has(key)) return;
		seen.add(key);
		roots.push({ path: normalized, source, rank, projectRoot });
	};
	if (typeof cwd === "string" && cwd !== "") {
		const project = await findProjectRoot(cwd);
		push(join(project, ".dsh", "skills"), "project-dsh", 100, project);
		push(join(project, ".agents", "skills"), "project-agents", 200, project);
	}
	push(join(dshHome, "skills"), "user-dsh", 400, undefined);
	push(join(agentsHome, "skills"), "user-agents", 500, undefined);
	return roots;
}

/** 根来源的稳定数字分级（越小优先级越高）。 */
export function sourceRank(source) {
	switch (source) {
		case "project-dsh": return 100;
		case "project-agents": return 200;
		case "user-dsh": return 400;
		case "user-agents": return 500;
		default: return 900;
	}
}

/** 布尔字段的宽容取值（与官方接受 yes/no/on/off/1/0）。 */
function looseBoolean(value) {
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") {
		const v = value.toLowerCase();
		if (["true", "yes", "on"].includes(v)) return true;
		if (["false", "no", "off"].includes(v)) return false;
	}
	return undefined;
}

/** 切出 `---` 包裹的 frontmatter 与正文；CRLF 归一为 LF。 */
export function splitFrontmatter(raw) {
	const text = String(raw).replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	if ((lines[0] ?? "").trim() !== "---") return undefined;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			return { yamlText: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
		}
	}
	return undefined;
}

/**
 * 面向列表的宽松 frontmatter 读取（坏值回退，不抛错）。
 * @returns {{name,description,whenToUse,modelInvocable,userInvocable,body}|undefined}
 */
export function parseFrontmatter(raw) {
	const parts = splitFrontmatter(raw);
	if (parts === undefined) return undefined;
	let data;
	try {
		data = parseYaml(parts.yamlText);
	} catch {
		return undefined;
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const pick = (key) => (typeof data[key] === "string" && data[key].trim() !== "" ? data[key].trim() : undefined);
	return {
		name: pick("name"),
		description: pick("description") ?? "",
		whenToUse: pick("whenToUse"),
		modelInvocable: looseBoolean(data["disable-model-invocation"]) !== true,
		userInvocable: looseBoolean(data["user-invocable"]) !== false,
		body: parts.body.trim()
	};
}

/**
 * 面向写入的严格 frontmatter 校验，与官方提供方的接收规则对齐。
 * @returns {{ok:true, name, description, whenToUse?}|{ok:false, error:string}}
 */
export function validateFrontmatter(raw) {
	const parts = splitFrontmatter(raw);
	if (parts === undefined) return { ok: false, error: "缺少 YAML frontmatter（文件必须以 --- 开头，并以 --- 结束）" };
	let data;
	try {
		data = parseYaml(parts.yamlText);
	} catch (error) {
		return { ok: false, error: `frontmatter 不是合法的 YAML：${error instanceof Error ? error.message : String(error)}` };
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		return { ok: false, error: "frontmatter 必须是键值对（YAML 映射）" };
	}
	for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"]) {
		if (Object.hasOwn(data, legacy)) {
			return { ok: false, error: `不支持旧字段 "${legacy}"，请改用 disable-model-invocation / user-invocable` };
		}
	}
	for (const key of ["disable-model-invocation", "user-invocable"]) {
		if (Object.hasOwn(data, key) && looseBoolean(data[key]) === undefined) {
			return { ok: false, error: `${key} 必须是布尔值` };
		}
	}
	const name = data.name;
	if (typeof name !== "string" || name.trim() === "") {
		return { ok: false, error: "frontmatter 缺少 name（必须是非空字符串）" };
	}
	if (!SKILL_NAME_RE.test(name.trim())) {
		return { ok: false, error: `name "${name.trim()}" 非法：只能是 kebab-case（小写字母、数字、连字符）` };
	}
	const description = data.description;
	if (typeof description !== "string" || description.trim() === "") {
		return { ok: false, error: "frontmatter 缺少 description（必须是非空字符串）" };
	}
	const result = { ok: true, name: name.trim(), description: description.trim() };
	if (typeof data.whenToUse === "string" && data.whenToUse.trim() !== "") result.whenToUse = data.whenToUse.trim();
	return result;
}

/**
 * 递归扫描根目录下的技能条目（启用 + 停用；目录束 + 平铺单文件）。
 * 含 `SKILL.md`（或 `SKILL.md.disabled`）的目录被视为技能包，不再下钻 ——
 * 包内的 `references/`、`scripts/` 属于该技能本身。
 */
async function scanDir(root, dir, rel, depth, entries) {
	if (depth >= MAX_DEPTH) return;
	let items;
	try {
		items = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // 目录缺失/不可读：视为空。
	}
	for (const item of items) {
		if (item.name.startsWith(".") || SKIP_DIR_NAMES.has(item.name)) continue;
		const full = join(dir, item.name);
		const isDir =
			item.isDirectory()
			|| (item.isSymbolicLink() && (await stat(full).catch(() => undefined))?.isDirectory() === true);
		if (isDir) {
			const md = join(full, "SKILL.md");
			const disabled = md + DISABLED_SUFFIX;
			const mdExists = await pathExists(md);
			const disabledExists = mdExists ? false : await pathExists(disabled);
			if (mdExists || disabledExists) {
				const file = mdExists ? md : disabled;
				const raw = await readFile(file, "utf8").catch(() => "");
				const parsed = parseFrontmatter(raw);
				entries.push(
					skillEntry(root, {
						name: parsed?.name ?? item.name,
						enabled: mdExists,
						kind: "bundle",
						file,
						rel: rel === "" ? item.name : `${rel}/${item.name}`,
						raw,
						parsed
					})
				);
			} else {
				await scanDir(root, full, rel === "" ? item.name : `${rel}/${item.name}`, depth + 1, entries);
			}
			continue;
		}
		// 平铺单文件只在根层收集，与官方提供方一致。
		if (item.isFile() && rel === "") {
			const disabledFlat = item.name.endsWith(`.md${DISABLED_SUFFIX}`);
			if (!disabledFlat && !item.name.endsWith(".md")) continue;
			// 读失败不再抛出：目录束那一支本来就 `.catch` 成空串，平铺单文件过去没有，
			// 于是一个不可读的 .md 会让整次扫描失败。统一成"列出来并标记不合规"，
			// 与上面「不合规的也要能看到才能修」的取舍保持一致。
			const raw = await readFile(full, "utf8").catch(() => "");
			const parsed = parseFrontmatter(raw);
			const suffix = disabledFlat ? `.md${DISABLED_SUFFIX}` : ".md";
			entries.push(
				skillEntry(root, {
					name: parsed?.name ?? item.name.slice(0, -suffix.length),
					enabled: !disabledFlat,
					kind: "flat",
					file: full,
					rel: "",
					raw,
					parsed
				})
			);
		}
	}
}

/**
 * 组装一个技能条目。
 *
 * 目录束 / 平铺 / 平铺停用这三个分支只有 name、enabled、kind、file、rel 不同，
 * 其余字段的来源完全一致。集中在这里构造，避免以后加字段时漏改其中一处 ——
 * 那正是三个分支各写一遍最容易出的错。
 */
function skillEntry(root, { name, enabled, kind, file, rel, raw, parsed }) {
	return {
		name,
		description: parsed?.description ?? "",
		whenToUse: parsed?.whenToUse,
		enabled,
		kind,
		file,
		source: root.source,
		projectRoot: root.projectRoot,
		rel,
		modelInvocable: parsed?.modelInvocable ?? true,
		userInvocable: parsed?.userInvocable ?? true,
		// 管理界面必须能看到不合规的技能（否则无法修复或删除），
		// 但要如实标记 —— 它在 DSH 里根本不会被加载。
		valid: validateFrontmatter(raw).ok
	};
}

/** 收集全部根下的技能条目。 */
export async function collectSkillEntries(roots) {
	const perRoot = await Promise.all(
		roots.map(async (root) => {
			const entries = [];
			await scanDir(root, root.path, "", 0, entries);
			return entries;
		})
	);
	return perRoot.flat();
}

/** 按名字选出胜出条目：根优先级更高的赢（与注册表 rank 语义一致）。 */
export function winnerEntry(entries, name) {
	const matches = entries.filter((entry) => entry.name === name);
	if (matches.length === 0) return undefined;
	matches.sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
	return matches[0];
}

/** 切换某个技能的启用状态（改名加/去 `.disabled`）。返回是否发生变化。 */
export async function setSkillEnabled(entry, enabled) {
	if (entry.enabled === enabled) return false;
	const target = enabled ? entry.file.slice(0, -DISABLED_SUFFIX.length) : entry.file + DISABLED_SUFFIX;
	await rename(entry.file, target);
	entry.file = target;
	entry.enabled = enabled;
	return true;
}

/** 读取技能文件的完整文本（用于查看/编辑）。 */
export async function readSkillText(file) {
	return readFile(file, "utf8");
}

/** 删除一个技能（目录束删整个目录，平铺删文件）。 */
export async function removeSkill(entry) {
	if (entry.kind === "bundle") {
		const dir = dirname(entry.file);
		await rm(dir, { recursive: true, force: true });
		return;
	}
	await rm(entry.file, { force: true });
}

/** 归一化落盘形态：只有显式 `flat` 才是单文件，其余（含缺省）一律目录束。 */
export function normalizeKind(kind) {
	return kind === "flat" ? "flat" : "bundle";
}

/**
 * 从技能名推导落盘的文件路径。
 * @param root  目标根
 * @param name  skill 名（kebab-case）
 * @param kind  `bundle`（目录束）| `flat`（单文件）
 */
export function skillTargetPath(root, name, kind) {
	return kind === "flat" ? join(root.path, `${name}.md`) : join(root.path, name, "SKILL.md");
}

/** 写出一个技能（必要时建目录）。返回落盘路径。 */
export async function writeSkillFile(root, name, kind, content) {
	const target = skillTargetPath(root, name, kind);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
	return target;
}
