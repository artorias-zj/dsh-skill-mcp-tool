/**
 * dsh-skill-mcp-tool —— 「粘贴 JSON 快速添加 MCP 服务器」。
 *
 * 为什么需要这个模块：手填表单对「从文档里复制一段现成配置」这个最常见的动作太慢。
 * 用户手里往往已经有一段能跑的 JSON —— Claude Desktop / Cursor 的 `mcpServers`、
 * VS Code 的 `servers`、或某个 README 里的示例 —— 却要逐字段抄进表单。
 *
 * 归一化规则全部收在这里，界面只负责「贴进来 → 预检 → 确认」，不重复一遍规则：
 *
 * 1. **认结构，不认出处。** 包装键（`mcpServers` / `servers` / `mcp`）可有可无；
 *    内容可以是一张「名字 → 配置」的表、一个数组、或单个服务器对象。
 * 2. **只认两种传输。** DSH 的 mcp-client 只有 `stdio` 与 `streamable-http`。
 *    遇到 `sse` / `http` / `streamableHttp` 等写法按 streamable-http 收下并给出
 *    警告，而不是直接拒绝 —— 但绝不假装能跑 SSE。
 * 3. **校验交给 normalizeServerInput。** 名字规则、URL 协议、args 类型只有那一处
 *    定义；这里不复制一遍，否则两套规则迟早漂移。
 * 4. **单条失败不拖垮整批。** 每条各自带 error，其余照常成为候选 —— 批量粘贴时
 *    因为一个名字带点就让整段配置作废，是最没道理的失败方式。
 *
 * @module dsh-skill-mcp-tool/mcp-json
 */
import { normalizeServerInput, SERVER_NAME_RE } from "./mcp-model.js";

/** 常见的包装键：Claude Desktop / Cursor 用 `mcpServers`，VS Code 用 `servers`。 */
const WRAPPER_KEYS = ["mcpServers", "mcp_servers", "servers", "mcp"];

/** 名字字段的别名（按优先级）。 */
const NAME_KEYS = ["serverName", "server_name", "name", "id"];

/** 「这是个服务器对象而不是名字映射」的判据字段。 */
const SERVER_FIELDS = ["command", "url", "httpUrl", "serverUrl", "type", "transport"];

/** 传输写法 → 本插件认的两种。`sse` 等不代表真的能用，只是给出最接近的推断。 */
const TRANSPORT_ALIASES = {
	stdio: "stdio",
	"streamable-http": "streamable-http",
	"streamable_http": "streamable-http",
	streamablehttp: "streamable-http",
	http: "streamable-http",
	"http-stream": "streamable-http",
	sse: "streamable-http"
};

/** 看着就像密钥的键名：只在值是明文时才提醒，避免误报 `NODE_ENV` 这类普通变量。 */
const SECRET_KEY_RE = /(token|key|secret|password|passwd|auth|cookie|credential)/i;

/** 取第一个「存在且非空」的字段值。空串按缺失处理 —— JSON 里常见 `"cwd": ""` 这种占位。 */
function firstDefined(source, keys) {
	for (const key of keys) {
		const value = source?.[key];
		if (value === undefined || value === null) continue;
		if (typeof value === "string" && value.trim() === "") continue;
		return value;
	}
	return undefined;
}

/**
 * 按 shell 习惯切分一行参数：引号内保留空格（Windows 路径尤其需要）。
 * 只处理单/双引号与空白，不解释通配符或变量 —— 参数是要原样交给子进程的。
 */
function splitCommandLine(text) {
	const out = [];
	let current = "";
	let quote = "";
	let has = false;
	for (const char of String(text)) {
		if (quote !== "") {
			if (char === quote) {
				quote = "";
				continue;
			}
			current += char;
			has = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			has = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (has) {
				out.push(current);
				current = "";
				has = false;
			}
			continue;
		}
		current += char;
		has = true;
	}
	if (has) out.push(current);
	return out;
}

/** env / headers：值是标量的键值对。JSON 里数字/布尔很常见，统一成字符串。 */
function scalarMap(value, label) {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是键值对`);
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === null || item === undefined) continue;
		if (typeof item === "object") throw new Error(`${label}.${key} 必须是字符串`);
		out[key] = String(item);
	}
	return out;
}

/** 把顶层 JSON 拆成 `{ name?, config }` 候选列表。 */
function collectEntries(data) {
	if (Array.isArray(data)) return data.map((item) => ({ name: undefined, config: item }));
	if (data === null || typeof data !== "object") return [];

	// 包装键：`{ "mcpServers": { ... } }`
	for (const key of WRAPPER_KEYS) {
		const value = data[key];
		if (value === undefined || value === null || typeof value !== "object") continue;
		if (Array.isArray(value)) return value.map((item) => ({ name: undefined, config: item }));
		return Object.entries(value).map(([name, config]) => ({ name, config }));
	}

	// 单个服务器对象：`{ "serverName": "x", "command": "npx" }`
	if (SERVER_FIELDS.some((key) => data[key] !== undefined)) return [{ name: undefined, config: data }];

	// 退化情形：没有包装键的名字映射 `{ "x": { "command": ... } }`
	const entries = [];
	for (const [name, config] of Object.entries(data)) {
		if (config !== null && typeof config === "object" && !Array.isArray(config)) entries.push({ name, config });
	}
	return entries;
}

/** 明文密钥提醒：只对「像密钥的键」+「不含 ${} 引用」的组合报警。 */
function warnPlaintextSecrets(serverName, map, kind, warnings) {
	const keys = Object.keys(map).filter((key) => SECRET_KEY_RE.test(key) && typeof map[key] === "string" && !map[key].includes("${"));
	if (keys.length === 0) return;
	warnings.push(`"${serverName}" 的 ${kind} 含明文值（${keys.join(", ")}）：会以明文写进 cordis.patch.yml，建议改写成 \${VAR} 引用环境变量`);
}

/**
 * 单条候选 → 归一化输入。
 *
 * @returns {{input: object, disabled: boolean|undefined, summary: string}}
 * @throws 字段缺失或不合规时抛出带上下文的错误（由调用方收集成该条的 error）
 */
function toServerInput(entry, warnings) {
	const config = entry.config;
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("服务器配置必须是一个对象");
	}

	const serverName = String(entry.name ?? firstDefined(config, NAME_KEYS) ?? "").trim();
	if (serverName === "") {
		throw new Error('缺少 serverName：请写成 "name": "..."，或用 { "名字": { ... } } 的形式');
	}
	if (!SERVER_NAME_RE.test(serverName)) {
		throw new Error(`serverName "${serverName}" 不合法：只能包含 1-32 位字母、数字、下划线或连字符`);
	}

	const declared = firstDefined(config, ["type", "transport"]);
	const url = firstDefined(config, ["url", "httpUrl", "serverUrl", "endpoint"]);
	let transport;
	if (declared !== undefined) {
		const spelling = String(declared).trim();
		transport = TRANSPORT_ALIASES[spelling.toLowerCase()] ?? TRANSPORT_ALIASES[spelling];
		if (transport === undefined) {
			throw new Error(`不支持的传输类型 "${spelling}"：DSH 的 MCP 客户端只支持 stdio 与 streamable-http`);
		}
		if (spelling.toLowerCase() === "sse") {
			warnings.push(`"${serverName}" 声明为 SSE：DSH 的 MCP 客户端不支持 SSE，已按 streamable-http 处理，请确认服务器同时提供该端点`);
		}
	}
	if (transport === undefined) transport = url !== undefined ? "streamable-http" : "stdio";

	const common = { serverName, transport };
	const timeout = firstDefined(config, ["toolCallTimeoutMs", "timeout", "toolCallTimeout"]);
	if (timeout !== undefined) common.toolCallTimeoutMs = timeout;
	if (typeof config.failOnStartupError === "boolean") common.failOnStartupError = config.failOnStartupError;
	if (config.reconnect !== null && typeof config.reconnect === "object" && !Array.isArray(config.reconnect)) {
		common.reconnect = config.reconnect;
	}

	let disabled;
	if (typeof config.disabled === "boolean") disabled = config.disabled;
	else if (typeof config.enabled === "boolean") disabled = !config.enabled;

	let input;
	let summary;
	if (transport === "stdio") {
		let command = config.command;
		let args = config.args ?? config.arguments;
		// 少数格式把整条命令塞进 command 数组：拆分而不是当成非法值。
		if (Array.isArray(command)) {
			const [head, ...rest] = command.map(String);
			command = head ?? "";
			const extra = args === undefined ? [] : Array.isArray(args) ? args.map(String) : splitCommandLine(String(args));
			args = [...rest, ...extra];
		}
		if (typeof command !== "string" || command.trim() === "") {
			throw new Error(`"${serverName}" 缺少 command：stdio 服务器必须给出要启动的命令`);
		}
		const argList = args === undefined || args === null ? [] : Array.isArray(args) ? args.map(String) : splitCommandLine(String(args));
		const env = scalarMap(config.env ?? config.environment, `"${serverName}" 的 env`);
		warnPlaintextSecrets(serverName, env, "env", warnings);
		const cwd = firstDefined(config, ["cwd", "workdir", "workingDirectory"]);
		input = { ...common, command: command.trim(), args: argList, env, cwd: cwd === undefined ? "" : String(cwd) };
		summary = `${command.trim()} ${argList.join(" ")}`.trim();
	} else {
		if (url === undefined) {
			throw new Error(`"${serverName}" 缺少 url：streamable-http 服务器必须给出服务地址`);
		}
		const headers = scalarMap(config.headers ?? config.requestHeaders, `"${serverName}" 的 headers`);
		warnPlaintextSecrets(serverName, headers, "headers", warnings);
		input = { ...common, url: String(url).trim(), headers };
		summary = String(url).trim();
	}

	// 最终校验只有这一处：名字规则、URL 协议、args 类型等都在 mcp-model 里定义。
	try {
		return { input: normalizeServerInput(input), disabled, summary };
	} catch (error) {
		throw new Error(`"${serverName}"：${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * 解析一段 JSON，产出可编辑、可导入的服务器候选。
 *
 * @param text 用户粘贴的 JSON 文本
 * @returns {{ok: boolean, servers: Array, errors: string[], warnings: string[]}}
 *          `ok` 表示「整段都解析成功」，不代表没有警告。
 */
export function parseMcpJson(text) {
	const errors = [];
	const warnings = [];
	const source = String(text ?? "").replace(/^\uFEFF/, "").trim();
	if (source === "") return { ok: false, servers: [], errors: ["JSON 内容为空"], warnings };

	let data;
	try {
		data = JSON.parse(source);
	} catch (error) {
		return {
			ok: false,
			servers: [],
			errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`],
			warnings
		};
	}

	const entries = collectEntries(data);
	if (entries.length === 0) {
		return { ok: false, servers: [], errors: ["没有找到任何 MCP 服务器定义"], warnings };
	}

	const servers = [];
	const used = new Map();
	for (const [index, entry] of entries.entries()) {
		let parsed;
		try {
			parsed = toServerInput(entry, warnings);
		} catch (error) {
			errors.push(`第 ${index + 1} 条：${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const name = parsed.input.serverName;
		if (used.has(name)) {
			errors.push(`第 ${index + 1} 条：serverName "${name}" 在 JSON 中重复（第 ${used.get(name) + 1} 条已占用）`);
			continue;
		}
		used.set(name, index);
		servers.push(parsed);
	}

	return { ok: errors.length === 0, servers, errors, warnings };
}
