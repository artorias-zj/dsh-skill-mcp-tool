/**
 * dsh-skill-mcp-tool —— 代理设置。
 *
 * 解决的问题：本插件装技能/更新技能都要 `git clone`，而很多网络环境下直连
 * `github.com` 会超时。此设置让用户在本插件内填一个代理地址，插件的 git 调用
 * 就走它 —— 不必去改全局 git 配置，也不必让用户记住 `git config` 命令。
 *
 * 三条设计约束（改动前请先读）：
 *
 * 1. **命令级注入，绝不写全局配置。**
 *    代理以 `git -c http.proxy=… <子命令>` 的形式注入（见 `git-source.js`）。
 *    用户全局的 `http.proxy` 一个字节都不动 —— 插件只是替这一次调用加参数。
 *    未启用时**不传任何参数**，于是自然沿用用户的全局配置（可能是直连，
 *    也可能是用户自己开的 `git p-on`）。
 *
 * 2. **代理地址可能内嵌凭据，按密钥对待。**
 *    `http://user:pass@host:port` 里的口令是密钥。回给浏览器的视图一律脱敏
 *    （`redactProxyUrl`），导出配置时默认也不写明文口令；用户仍然可以在输入框
 *    里看到脱敏形态并保存 —— 提交串里留着 `***` 就会沿用已存的口令
 *    （`mergeProxyUrl`），因此「看一眼再保存」不会把口令清掉。
 *
 * 3. **设置文件独立于 patch 文件。**
 *    写到 `<DSH_HOME>/skill-mcp-tool/settings.json`，与 `sources.json` 同级。
 *    `cordis.patch.yml` 是宿主的配置，本插件只拥有受管块之间的字节；把插件
 *    自己的设置塞进那里会破坏「外来内容原样保留」的承诺。
 *
 * @module dsh-skill-mcp-tool/proxy-store
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 设置文件格式版本。 */
export const SETTINGS_VERSION = 1;
/** 脱敏占位符（回给浏览器、以及默认导出时替代口令）。 */
export const REDACTED = "***";

/** git/curl 支持的代理协议。 */
const PROXY_SCHEMES = new Set(["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

/** `scheme://userinfo@` 前缀 —— 凭据只可能出现在这一段。 */
const USERINFO_PREFIX = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)(@)/i;

/** 设置文件路径。 */
export function settingsFile(dshHome) {
	return join(dshHome, "skill-mcp-tool", "settings.json");
}

/** 取出 URL 里的口令（没有则空串）。刻意不用 `new URL` —— 那会改写原串。 */
function passwordOf(url) {
	const match = USERINFO_PREFIX.exec(String(url ?? ""));
	if (match === null) return "";
	const colon = match[2].indexOf(":");
	return colon < 0 ? "" : match[2].slice(colon + 1);
}

/** 代理地址里是否内嵌**口令**。用户名的单独存在不算密钥。 */
export function hasCredentials(url) {
	const match = USERINFO_PREFIX.exec(String(url ?? ""));
	if (match === null) return false;
	return match[2].includes(":");
}

/**
 * 脱敏：把 `scheme://user:pass@` 里的口令换成 `***`，其余字节原样保留。
 * 只有用户名（无口令）不算密钥，保持原样 —— 脱敏是为了藏口令，不是藏主机。
 */
export function redactProxyUrl(url) {
	const raw = String(url ?? "");
	const match = USERINFO_PREFIX.exec(raw);
	if (match === null) return raw;
	const colon = match[2].indexOf(":");
	if (colon < 0) return raw;
	return `${match[1]}${match[2].slice(0, colon)}:${REDACTED}${match[3]}${raw.slice(match[0].length)}`;
}

/**
 * 合并「浏览器提交的地址」与「已存地址」。
 *
 * 输入框里显示的是脱敏串。用户只改了主机/端口而没动凭据时，提交串里仍是
 * `***` —— 这时把已存口令填回去，否则一次「看一眼再保存」就会静默清空口令。
 *
 * 已存口令为空（或本机没存过）时连那个冒号一起摘掉，落成 `http://user@host`
 * 而不是 `http://user:@host` —— 后者是个「密码为空」的代理凭据，会让 git
 * 真的拿空密码去认证，比不给用户名更难排查。
 *
 * 提交串里没有 `***` 就按用户输入的字面值处理（改口令、去凭据都走这条）。
 */
export function mergeProxyUrl(submitted, stored) {
	const next = String(submitted ?? "").trim();
	if (!next.includes(REDACTED)) return next;
	const password = passwordOf(stored);
	if (password !== "") return next.split(REDACTED).join(password);
	return next.split(`:${REDACTED}`).join("").split(REDACTED).join("");
}

/**
 * 校验并归一化代理地址。
 * 空串合法 —— 表示「不指定代理」（沿用全局 git 配置）。
 */
export function normalizeProxyUrl(raw) {
	const value = String(raw ?? "").trim();
	if (value === "") return "";
	// 控制字符会让 `git -c http.proxy=…` 的值难以预料，直接拒绝。
	if (/[\s\u0000-\u001f]/.test(value)) throw new Error("代理地址不能包含空格、制表符或换行");
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`代理地址不是合法 URL："${value}"`);
	}
	const scheme = parsed.protocol.toLowerCase();
	if (!PROXY_SCHEMES.has(scheme)) {
		throw new Error(`代理地址协议不支持："${parsed.protocol}"（支持 http / https / socks4 / socks5）`);
	}
	if (parsed.hostname === "") throw new Error(`代理地址缺少主机名："${value}"`);
	return value;
}

/** 读取设置（缺失/损坏一律回落到默认值，设置文件不该让插件起不来）。 */
export async function loadSettings(dshHome) {
	const fallback = { proxy: { enabled: false, url: "" } };
	try {
		const parsed = JSON.parse(await readFile(settingsFile(dshHome), "utf8"));
		const proxy = parsed?.proxy ?? {};
		return {
			proxy: {
				enabled: proxy.enabled === true,
				url: typeof proxy.url === "string" ? proxy.url : ""
			}
		};
	} catch {
		return fallback;
	}
}

/** 写入设置。 */
export async function saveSettings(dshHome, settings) {
	const file = settingsFile(dshHome);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`, "utf8");
}

/**
 * 当前**生效**的代理地址：未启用或未填写时返回空串。
 *
 * 空串是有意义的返回值 —— 调用方据此决定「不传 `-c http.proxy`」，
 * 从而沿用用户自己的全局配置，而不是强行清空代理。
 */
export async function activeProxyUrl(dshHome) {
	const { proxy } = await loadSettings(dshHome);
	return proxy.enabled && proxy.url !== "" ? proxy.url : "";
}

/** 回给浏览器的视图：口令脱敏，并告知「这里原本有凭据」。 */
export function proxyView(proxy) {
	const url = typeof proxy?.url === "string" ? proxy.url : "";
	return {
		enabled: proxy?.enabled === true,
		url: redactProxyUrl(url),
		hasCredentials: hasCredentials(url)
	};
}
