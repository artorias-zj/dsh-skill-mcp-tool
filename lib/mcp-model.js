/**
 * dsh-skill-mcp-tool —— MCP 服务器配置模型。
 *
 * 目标形状对齐官方 `@deepseek-ai/dsh-mcp-client` 的 Config：
 *   stdio:            { transport, serverName, command, args[], env{}, cwd, ... }
 *   streamable-http:  { transport, serverName, url, headers{}, ... }
 *   公共:             { toolCallTimeoutMs, failOnStartupError, reconnect{...} }
 *
 * env / headers 的值允许是 `!!js` 表达式（`{ __jsExpr }` 标记对象）。为了让用户
 * 能直接写直觉写法 `${GITHUB_TOKEN}`，这里在「文本 → wire 值」时把 `${NAME}`
 * 改写成 `${process.env.NAME}` 再包成 `!!js` 模板字面量，反向则收回展示写法。
 * 这是 DSH 里唯一的变量注入机制（cordis 配置层没有 `${VAR}` 插值）。
 *
 * @module dsh-skill-mcp-tool/mcp-model
 */
import { isJsExprValue, MCP_PLUGIN_NAME, ROW_ID_PREFIX } from "./patch-store.js";

/** serverName 约束，与官方 mcp-client 的 SERVER_NAME_PATTERN 一致。 */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
export const DEFAULT_RECONNECT = { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 };
/** 进阶逃生口：值以此前缀开头即原样透传为 JS 表达式。 */
export const JS_EXPR_PREFIX = "!!js";

/** `${NAME}` → `${process.env.NAME}`；其它 `${...}` 原样保留（用户可写任意 JS）。 */
const ENV_REF_RE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
/** 反向收回：`${process.env.NAME}` → `${NAME}`。 */
const ENV_REF_FROM_EXPR_RE = /\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function envRefsToExpression(text) {
	return text.replace(ENV_REF_RE, (_match, name) => `\${process.env.${name}}`);
}

/**
 * `!!js` 表达式收回直觉写法：仅当「单层反引号模板且含 `${`」才收；
 * 复杂表达式仍旧显示 `!!js 原文`。
 */
export function expressionToDisplay(expression) {
	const template = /^`([^`]*)`$/.exec(expression);
	if (template === null || !template[1].includes("${")) return expression;
	return template[1].replace(ENV_REF_FROM_EXPR_RE, (_match, name) => `\${${name}}`);
}

/**
 * 文本 → wire 值，三种写法都认：
 *   1. `${NAME}` / `Bearer ${NAME}` —— 直觉写法，自动包成 `!!js` 模板字面量；
 *   2. 已写好的反引号模板 —— 同样补 `process.env`，其余内容不动；
 *   3. `!!js <表达式>` —— 进阶逃生口，原样透传。
 */
export function parseWireScalar(text) {
	const raw = String(text);
	const trimmed = raw.trim();
	if (trimmed === JS_EXPR_PREFIX || trimmed.startsWith(`${JS_EXPR_PREFIX} `)) {
		const expression = trimmed.slice(JS_EXPR_PREFIX.length).trim();
		return expression === "" ? raw : { __jsExpr: expression };
	}
	if (!trimmed.includes("${")) return raw;
	if (trimmed.length > 1 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
		return { __jsExpr: envRefsToExpression(trimmed) };
	}
	return { __jsExpr: "`" + envRefsToExpression(raw) + "`" };
}

/** wire 值 → 文本形式（页面回填用）。 */
export function formatWireScalar(value) {
	if (isJsExprValue(value)) {
		const display = expressionToDisplay(value.__jsExpr);
		return display === value.__jsExpr ? `${JS_EXPR_PREFIX} ${value.__jsExpr}` : display;
	}
	return typeof value === "string" ? value : "";
}

/** 校验失败时抛出带字段名的中文错误。 */
function fail(message) {
	throw new Error(message);
}

function requireString(value, field, { allowEmpty = false } = {}) {
	if (typeof value !== "string") fail(`${field} 必须是字符串`);
	if (!allowEmpty && value.trim() === "") fail(`${field} 不能为空`);
	return value;
}

function requireBoolean(value, field) {
	if (typeof value !== "boolean") fail(`${field} 必须是布尔值`);
	return value;
}

function optionalPositiveInt(value, field, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < 1) fail(`${field} 必须是大于 0 的数字`);
	return Math.floor(n);
}

/**
 * 归一化 wire 标量表（env / headers）：值为 string 或 `!!js` 表达式。
 *
 * 关键：字符串值会先过 `parseWireScalar`，让用户写的 `${MY_TOKEN}` 升级成
 * `!!js` 模板字面量。若跳过这一步，`${MY_TOKEN}` 会作为普通字符串落盘，
 * 宿主不做插值、原样发给 MCP 服务器 —— 令牌永远发不出去且没有任何提示。
 */
function normalizeScalarMap(value, field) {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) fail(`${field} 必须是键值对`);
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = parseWireScalar(item);
		else if (isJsExprValue(item)) out[key] = item;
		else if (item === null || item === undefined) continue;
		else fail(`${field}.${key} 必须是字符串或 !!js 表达式`);
	}
	return out;
}

/**
 * 校验并归一化一份 MCP 服务器输入。
 * @param input 来自 UI / 文件的行输入（宽松）。
 * @returns 归一化后的输入对象。
 */
export function normalizeServerInput(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) fail("MCP 配置必须是一个对象");
	const serverName = requireString(input.serverName, "serverName");
	if (!SERVER_NAME_RE.test(serverName)) {
		fail("serverName 只能包含 1-32 位字母、数字、下划线或连字符");
	}
	const transport = input.transport === "streamable-http" ? "streamable-http" : input.transport === "stdio" ? "stdio" : undefined;
	if (transport === undefined) fail('transport 必须是 "stdio" 或 "streamable-http"');

	const common = {
		serverName,
		transport,
		toolCallTimeoutMs: optionalPositiveInt(input.toolCallTimeoutMs, "toolCallTimeoutMs", DEFAULT_TOOL_CALL_TIMEOUT_MS),
		failOnStartupError: input.failOnStartupError === undefined ? false : requireBoolean(input.failOnStartupError, "failOnStartupError"),
		reconnect: normalizeReconnect(input.reconnect)
	};

	if (transport === "stdio") {
		const command = requireString(input.command, "command");
		const args = input.args === undefined || input.args === null ? [] : input.args;
		if (!Array.isArray(args)) fail("args 必须是字符串数组");
		const cwd = input.cwd === undefined || input.cwd === null ? "" : input.cwd;
		if (typeof cwd !== "string") fail("cwd 必须是字符串");
		// args 元素允许是表达式的字符串形式：UI 传纯字符串，这里统一成 wire 值。
		const wireArgs = args.map((item, index) => {
			if (typeof item === "string") return item;
			if (isJsExprValue(item)) return item;
			fail(`args[${index}] 必须是字符串`);
		});
		return { ...common, command, args: wireArgs, env: normalizeScalarMap(input.env, "env"), cwd };
	}

	const url = requireString(input.url, "url");
	if (!/^https?:\/\//i.test(url) && !isJsExprValue(input.url)) {
		fail("url 必须是 http(s) 地址");
	}
	return { ...common, url, headers: normalizeScalarMap(input.headers, "headers") };
}

function normalizeReconnect(value) {
	const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		enabled: raw.enabled === undefined ? DEFAULT_RECONNECT.enabled : requireBoolean(raw.enabled, "reconnect.enabled"),
		initialDelayMs: optionalPositiveInt(raw.initialDelayMs, "reconnect.initialDelayMs", DEFAULT_RECONNECT.initialDelayMs),
		maxDelayMs: optionalPositiveInt(raw.maxDelayMs, "reconnect.maxDelayMs", DEFAULT_RECONNECT.maxDelayMs),
		maxAttempts: optionalPositiveInt(raw.maxAttempts, "reconnect.maxAttempts", DEFAULT_RECONNECT.maxAttempts)
	};
}

/** 受管行 id ↔ serverName。 */
export function rowIdForServerName(serverName) {
	return `${ROW_ID_PREFIX}${serverName}`;
}

export function serverNameFromRowId(id) {
	if (typeof id !== "string" || !id.startsWith(ROW_ID_PREFIX)) return undefined;
	const name = id.slice(ROW_ID_PREFIX.length);
	return SERVER_NAME_RE.test(name) ? name : undefined;
}

/** 归一化输入 + enabled → cordis.patch.yml 行。 */
export function toPatchRow(input, enabled = true) {
	const normalized = normalizeServerInput(input);
	const { transport, serverName, toolCallTimeoutMs, failOnStartupError, reconnect } = normalized;
	const config = {
		serverName,
		toolCallTimeoutMs,
		failOnStartupError,
		reconnect,
		transport
	};
	if (transport === "stdio") {
		config.command = normalized.command;
		config.args = normalized.args;
		config.env = normalized.env;
		config.cwd = normalized.cwd;
	} else {
		config.url = normalized.url;
		config.headers = normalized.headers;
	}
	return {
		id: rowIdForServerName(serverName),
		name: MCP_PLUGIN_NAME,
		...(enabled ? {} : { disabled: true }),
		config
	};
}

/** 读取行内的 config（宽松，坏行返回 undefined）。 */
export function configFromPatchRow(row) {
	if (row === undefined || row.name !== MCP_PLUGIN_NAME) return undefined;
	if (row.config === null || typeof row.config !== "object" || Array.isArray(row.config)) return undefined;
	return row.config;
}

function secretKeys(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.keys(value).filter((key) => typeof value[key] === "string" || isJsExprValue(value[key]));
}

/**
 * patch 行 → 脱敏 view（不返回密钥值，只返回键名）。
 * 返回 undefined 表示该行无法解析成合法服务器。
 */
export function patchRowToView(row) {
	const config = configFromPatchRow(row);
	if (config === undefined) return undefined;
	const serverName = typeof config.serverName === "string" ? config.serverName : "";
	if (!SERVER_NAME_RE.test(serverName)) return undefined;
	const transport =
		config.transport === "streamable-http" ? "streamable-http" : config.transport === "stdio" ? "stdio" : "unknown";
	const reconnectRaw = config.reconnect !== null && typeof config.reconnect === "object" ? config.reconnect : {};
	const isStdio = transport === "stdio";
	return {
		serverName,
		transport,
		enabled: row.disabled !== true,
		entryId: typeof row.id === "string" ? row.id : undefined,
		command: isStdio ? formatWireScalar(config.command) : undefined,
		args: isStdio && Array.isArray(config.args) ? config.args.map((item) => formatWireScalar(item)) : undefined,
		envKeys: isStdio ? secretKeys(config.env) : [],
		cwd: isStdio ? formatWireScalar(config.cwd) : undefined,
		url: transport === "streamable-http" ? formatWireScalar(config.url) : undefined,
		headerKeys: transport === "streamable-http" ? secretKeys(config.headers) : [],
		toolCallTimeoutMs:
			typeof config.toolCallTimeoutMs === "number" ? config.toolCallTimeoutMs : DEFAULT_TOOL_CALL_TIMEOUT_MS,
		failOnStartupError: config.failOnStartupError === true,
		reconnect: {
			enabled: reconnectRaw.enabled !== false,
			initialDelayMs: typeof reconnectRaw.initialDelayMs === "number" ? reconnectRaw.initialDelayMs : DEFAULT_RECONNECT.initialDelayMs,
			maxDelayMs: typeof reconnectRaw.maxDelayMs === "number" ? reconnectRaw.maxDelayMs : DEFAULT_RECONNECT.maxDelayMs,
			maxAttempts: typeof reconnectRaw.maxAttempts === "number" ? reconnectRaw.maxAttempts : DEFAULT_RECONNECT.maxAttempts
		}
	};
}

/** 在受管行与外部行之间检测重复 serverName。 */
export function duplicateServerNames(managedRows, externalRows) {
	const names = new Map();
	const add = (rows, owner) => {
		for (const row of rows) {
			const name = configFromPatchRow(row)?.serverName;
			if (typeof name !== "string" || !SERVER_NAME_RE.test(name)) continue;
			names.set(name, [...(names.get(name) ?? []), owner]);
		}
	};
	add(managedRows, "managed");
	add(externalRows, "external");
	return [...names.entries()].filter(([, owners]) => owners.length > 1).map(([name]) => name);
}
