/**
 * dsh-skill-mcp-tool —— profile `cordis.patch.yml` 受管块编辑器（MCP 服务器行）。
 *
 * 设计要点（与实现约束直接对应）：
 *
 * 1. **只动自己标记之间的字节。** MCP 服务器在 DSH 里就是一行 loader 条目
 *    （`name: '@deepseek-ai/dsh-mcp-client'`），插件无权在运行时增删连接，
 *    唯一受支持的路径是「写配置 → HMR 重挂载」。因此这里只重写
 *    `# >>> dsh-skill-mcp-tool:mcp:begin` / `:end` 之间的内容，标记之外
 *    逐字节保留 —— 其他插件（例如 dsh-skill-mcp-panel）的受管块和用户手写的
 *    行都不会被碰到。
 *
 * 2. **`!!js` 标签必须原样往返。** cordis 配置层没有 `${VAR}` 插值，读环境变量
 *    的唯一机制是 YAML 的 `!!js` 表达式（宿主装载时 `new Function` 求值）。
 *    若把 `!!js` 当普通字符串读再整块重写，表达式会退化成字面量 —— 用户的令牌
 *    从此永远发不出去且没有任何提示。所以这里注册自定义标签：读时还原成
 *    `{ __jsExpr }` 标记对象，写时按原标签回写。
 *
 * 3. **写入必须原子且串行。** Web 宿主与 CLI 可能并发写同一个文件，用 `<path>.lock`
 *    文件锁 + 同目录临时文件 rename 保证。
 *
 * @module dsh-skill-mcp-tool/patch-store
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { compareName } from "./name-order.js";

/** 受管块起始标记（行首注释）。 */
export const BLOCK_BEGIN = "# >>> dsh-skill-mcp-tool:mcp:begin";
/** 受管块结束标记（行首注释）。 */
export const BLOCK_END = "# <<< dsh-skill-mcp-tool:mcp:end";
/** 官方 MCP 客户端包名 —— 受管行的 `name` 字段恒为它。 */
export const MCP_PLUGIN_NAME = "@deepseek-ai/dsh-mcp-client";
/** 受管行 id 前缀。 */
export const ROW_ID_PREFIX = "smt-mcp-";

/** cordis 配置层的 `!!js` 标签 URI。 */
const JS_EXPR_TAG = "tag:yaml.org,2002:js";

/** 表达式含换行时无法用单引号标量安全往返，退回 JSON 双引号转义。 */
function quoteJsExpr(expression) {
	return /[\n\r]/.test(expression) ? JSON.stringify(expression) : "'" + expression.replace(/'/g, "''") + "'";
}

/**
 * 自定义 `!!js` 标签：`identify` 只认「恰好一个 `__jsExpr` 字符串键」的对象，
 * 不会误伤普通配置对象。
 */
const jsExprTag = {
	tag: JS_EXPR_TAG,
	resolve: (value) => ({ __jsExpr: value }),
	identify: (value) =>
		value !== null
		&& typeof value === "object"
		&& Object.keys(value).length === 1
		&& typeof value.__jsExpr === "string",
	stringify: (node) => quoteJsExpr(String(node.value.__jsExpr))
};

/** 全部解析与序列化共用同一份标签定义，读到的 `!!js` 才能原样写回。 */
export const YAML_CUSTOM_TAGS = [jsExprTag];

/** 判断一个 YAML 值是否是保留的 `!!js` 表达式节点。 */
export function isJsExprValue(value) {
	return jsExprTag.identify(value);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读取 patch 文件。
 *
 * 文件**不存在**时返回空数组模板 `[]`，而不是抛错 —— 新机器上还没有这个文件
 * 是正常状态（profile 首次运行、或刚换电脑要导入配置）。若当成错误，导入流程
 * 会在第一步就崩，而这恰恰是本插件要支持的场景。
 *
 * 其它读取失败（权限、目录等）仍然报错：那才是真的有问题。
 */
export async function readPatchFile(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return "[]\n";
		throw new Error(`无法读取 cordis.patch.yml（${path}）：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 校验整份 patch 文本：可解析且顶层是数组。不解出/写回任何值。 */
export function validatePatchText(raw) {
	const doc = parseDocument(raw, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
	if (doc.errors.length > 0) {
		throw new Error(`cordis.patch.yml 解析失败：${String(doc.errors[0]?.message ?? doc.errors[0])}`);
	}
	const parsed = doc.toJS();
	if (!Array.isArray(parsed)) throw new Error("cordis.patch.yml 顶层必须是 YAML 数组");
}

/** 把 YAML 解析出的顶层条目拍平成 patch 行。 */
function flattenPatchRows(entries) {
	const rows = [];
	if (!Array.isArray(entries)) return rows;
	const pushRow = (value) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return;
		if (typeof value.id !== "string" && typeof value.name !== "string") return;
		const normalized = { ...value };
		if (typeof normalized.id !== "string") delete normalized.id;
		if (typeof normalized.name !== "string") delete normalized.name;
		if (typeof normalized.disabled !== "boolean") delete normalized.disabled;
		if (normalized.config === null || typeof normalized.config !== "object" || Array.isArray(normalized.config)) {
			delete normalized.config;
		}
		rows.push(normalized);
	};
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		if (Array.isArray(entry.insert)) for (const row of entry.insert) pushRow(row);
		else pushRow(entry);
	}
	return rows;
}

/** 提取 begin/end 标记之间的受管行；无标记返回空数组。 */
export function extractManagedRows(raw) {
	const begin = raw.indexOf(BLOCK_BEGIN);
	const end = raw.indexOf(BLOCK_END);
	if (begin < 0 && end < 0) return [];
	if (begin < 0 || end < 0 || end < begin) {
		throw new Error("cordis.patch.yml 中 dsh-skill-mcp-tool 受管块标记不完整（begin/end 必须成对）");
	}
	const blockStart = raw.indexOf("\n", begin);
	if (blockStart < 0) throw new Error("cordis.patch.yml 受管块格式损坏");
	const blockText = raw.slice(blockStart + 1, end);
	const doc = parseDocument(blockText, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
	if (doc.errors.length > 0) throw new Error(`受管块解析失败：${String(doc.errors[0]?.message ?? doc.errors[0])}`);
	const parsed = doc.toJS();
	if (!Array.isArray(parsed)) throw new Error("受管块内容必须是 YAML 数组");
	return flattenPatchRows(parsed);
}

/** 解析整份 patch 并返回其中所有 MCP 客户端行（不区分是否受管）。 */
export function listMcpPatchRows(raw) {
	const doc = parseDocument(raw, { logLevel: "silent", customTags: YAML_CUSTOM_TAGS });
	if (doc.errors.length > 0) return [];
	const parsed = doc.toJS();
	if (!Array.isArray(parsed)) return [];
	return flattenPatchRows(parsed).filter((row) => row.name === MCP_PLUGIN_NAME);
}

/** 生成受管块文本（无行时为空字符串）。 */
export function generateManagedBlock(rows) {
	if (rows.length === 0) return "";
	const body = stringify([{ insert: rows }], { indent: 2, lineWidth: 0, customTags: YAML_CUSTOM_TAGS });
	return `${BLOCK_BEGIN}\n${body}${BLOCK_END}\n`;
}

/**
 * 替换受管块；无标记且要写入行时追加到文件末尾。标记之外的所有字节原样保留。
 */
export function replaceManagedBlock(raw, rows) {
	const begin = raw.indexOf(BLOCK_BEGIN);
	const end = raw.indexOf(BLOCK_END);
	const block = generateManagedBlock(rows);
	if (begin >= 0 || end >= 0) {
		if (begin < 0 || end < 0 || end < begin) {
			throw new Error("cordis.patch.yml 中 dsh-skill-mcp-tool 受管块标记不完整（begin/end 必须成对）");
		}
		const lineStart = raw.lastIndexOf("\n", begin - 1) + 1;
		const afterEnd = raw.indexOf("\n", end);
		const lineEnd = afterEnd < 0 ? raw.length : afterEnd + 1;
		const next = raw.slice(0, lineStart) + block + raw.slice(lineEnd);
		if (block !== "") return next;
		// 删掉最后一批受管行后，文件可能只剩注释（或原本就是 `[]` 模板）；
		// 此时必须补回流式空数组，否则 patch 文件不再是合法顶层数组。
		const meaningful = next.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
		if (meaningful.length === 0) return `${next.replace(/\s*$/, "")}\n[]\n`;
		return next;
	}
	if (block === "") return raw;
	// 空 profile 模板是流式空数组 `[]`：直接追加块序列会变成 `[] - insert`，
	// 必须在追加前把 `[]` 替换成受管块序列。
	const meaningful = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
	if (meaningful.length === 1 && meaningful[0] === "[]") {
		const index = raw.lastIndexOf("[]");
		return raw.slice(0, index) + block + raw.slice(index + 2);
	}
	const prefix = raw.length === 0 ? "" : raw.endsWith("\n") ? "\n" : "\n\n";
	return raw + prefix + block;
}

/** 同目录临时文件 + rename 原子写；Windows 上 rename 覆盖失败时退化为 rm + rename。 */
export async function writeFileAtomic(path, content) {
	const temp = join(dirname(path), `.dsh-smt-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	try {
		await writeFile(temp, content, "utf8");
		try {
			await rename(temp, path);
		} catch (error) {
			const code = error !== null && typeof error === "object" ? error.code : undefined;
			if (!["EPERM", "EEXIST", "EACCES"].includes(code ?? "")) throw error;
			await rm(path, { force: true });
			await rename(temp, path);
		}
	} finally {
		await rm(temp, { force: true }).catch(() => {});
	}
}

/**
 * 以 `<path>.smt.lock` 为锁执行 fn。锁文件记录 pid + 时间；超过 30 秒视为
 * 陈旧锁自动清理。获取超时 5 秒。
 */
export async function withPatchLock(path, fn) {
	const lockPath = `${path}.smt.lock`;
	// 新机器上 profile 目录可能还不存在，锁文件就创建不出来。
	// 先确保父目录存在（幂等），否则导入会在写锁这一步失败。
	await mkdir(dirname(lockPath), { recursive: true });
	const started = Date.now();
	let handle;
	while (handle === undefined) {
		try {
			handle = await open(lockPath, "wx");
		} catch (error) {
			const code = error !== null && typeof error === "object" ? error.code : undefined;
			if (code !== "EEXIST") throw error;
			try {
				const info = await stat(lockPath);
				if (Date.now() - info.mtimeMs > 30000) await rm(lockPath, { force: true }).catch(() => {});
			} catch {
				// 锁在检查间隙被释放：继续重试。
			}
			if (Date.now() - started > 5000) throw new Error("等待 cordis.patch.yml 写锁超时（可能有其他进程正在写入）");
			await delay(50);
		}
	}
	try {
		await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
		return await fn();
	} finally {
		await handle.close().catch(() => {});
		await rm(lockPath, { force: true }).catch(() => {});
	}
}

/**
 * 读取 patch、替换受管块、校验、加锁原子写回。返回写回后的完整文本。
 *
 * 受管行在这里统一按 serverName 首字母排序 —— 所有写入路径（新增、编辑、
 * 启用/停用、删除）都经过本函数，排序放在这一层就不会有哪条路径漏排。
 * 受管行彼此独立（各自一行 loader 条目），重排不影响语义，只影响文件可读性
 * 与界面顺序。
 */
export async function writeManagedRows(path, rows) {
	return withPatchLock(path, async () => {
		const raw = await readPatchFile(path);
		const ordered = Array.isArray(rows)
			? [...rows].sort((a, b) => compareName(a?.config?.serverName, b?.config?.serverName))
			: rows;
		const next = replaceManagedBlock(raw, ordered);
		validatePatchText(next);
		await writeFileAtomic(path, next);
		return next;
	});
}
