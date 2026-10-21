/**
 * dsh-skill-mcp-tool —— 宿主半区。
 *
 * 统一管理 **Skills** 与 **MCP**，两者都通过 profile 的 `cordis.patch.yml` /
 * 技能文件系统落到「真实状态」，再交给 DSH 自己的热加载机制生效：
 *
 *   - **MCP**：一个服务器 = 一行 loader 条目。运行时没有增删连接的 API，
 *     唯一受支持的路径是「写 patch 文件 → HMR 重挂载这一行」。
 *     启用/停用 = 行上的 `disabled` 布尔值。
 *   - **Skills**：文件技能启用/停用 = 改名加/去 `.disabled`；提供方 watcher
 *     感知后下一次目录刷新即生效。插件注册的技能（无文件）只读列出。
 *
 * 对外只暴露同源 HTTP 路由（`/dsh-skill-mcp-tool/*`）。不依赖 Typert 生成器，
 * 因此单个包即可自洽运行。
 *
 * @module dsh-skill-mcp-tool
 */
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
	PAYLOAD_MODES,
	buildBundle,
	parseBundle,
	readSkillFiles,
	writeSkillFiles
} from "./bundle.js";
import { checkSourceUpdate, checkGitAvailable, forgetSource, installFromRepo, loadSources, probeRemote, saveSources } from "./git-source.js";
import { duplicateServerNames, normalizeServerInput, patchRowToView, serverNameFromRowId, toPatchRow } from "./mcp-model.js";
import { compareName, sortByName } from "./name-order.js";
import { extractManagedRows, listMcpPatchRows, readPatchFile, writeManagedRows } from "./patch-store.js";
import { REDACTED, activeProxyUrl, loadSettings, mergeProxyUrl, normalizeProxyUrl, proxyView, redactProxyUrl, saveSettings } from "./proxy-store.js";
import { authorizationHeader, forgetOAuthRecord, loadOAuth, oauthView, readOAuthRecord, refreshServer, runAuthorization } from "./oauth.js";
import { checkPluginUpdate, readUpdateLog, readUpdateState, repoUrlOf, startPluginUpdate } from "./self-update.js";
import { SKILL_PROVIDER_NAME, registerSkillProvider } from "./skill-provider.js";
import {
	buildRoots,
	collectSkillEntries,
	normalizeKind,
	pathExists,
	readSkillText,
	removeSkill,
	setSkillEnabled,
	validateFrontmatter,
	winnerEntry,
	writeSkillFile,
	DISABLED_SUFFIX
} from "./skill-store.js";

export const name = "dsh-skill-mcp-tool";

/**
 * 本插件的 package.json（版本与上游地址都从这里取）。
 *
 * 不用写死的常量：版本号是发行时才会改的东西，写死一处就一定会忘记同步，
 * 于是导出的配置包与「检查更新」里长期带着过期的版本（排查问题时会误导）。
 * 仓库地址同理 —— 换个仓库却忘了改常量，自更新会去检查一个不相干的远端。
 */
const PLUGIN_MANIFEST = createRequire(import.meta.url)("../package.json");
const PLUGIN_VERSION = PLUGIN_MANIFEST.version;

/**
 * 硬依赖的宿主服务。
 *
 * `loader` 必须 inject：cordis 的作用域隔离下 `ctx.get("loader")` 在未声明依赖时
 * 取不到它，而「确认写入的 MCP 行到底有没有热挂载上」正是本插件的核心承诺 ——
 * 拿不到 loader 就只能盲报成功。其余服务（skills / tools / configEditor /
 * webServer）走 `ctx.get` 的可选路径，缺失时各自降级。
 */
export const inject = ["loader"];

/** 路由前缀。 */
const ROUTE_PREFIX = "/dsh-skill-mcp-tool";
/** fiber 状态 → 可读阶段名。 */
const FIBER_PHASE = { 0: "pending", 1: "loading", 2: "active", 3: "failed", 4: null, 5: "unloading" };

// ── HTTP 工具 ────────────────────────────────────────────────────────────────

function sendJson(response, status, value) {
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

/** 把回环别名归一，便于同源比较（localhost / 127.0.0.1 / [::1] 是同一台机器）。 */
function normalizeAuthority(authority) {
	if (typeof authority !== "string" || authority === "") return undefined;
	const lower = authority.toLowerCase();
	const match = /^(\[::1\]|localhost|127\.0\.0\.1)(:(\d+))?$/.exec(lower);
	if (match === null) return lower;
	return `loopback:${match[3] ?? "80"}`;
}

/**
 * 只接受同源写请求。浏览器跨站请求会带 Origin，与 Host 不匹配即拒绝 ——
 * 这挡住了「任意网页通过 fetch 读改本机 patch 文件」的路径。
 */
function isTrustedWrite(request) {
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin === "") return true; // 非浏览器客户端
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	const host = request.headers.host;
	return normalizeAuthority(parsed.host) !== undefined && normalizeAuthority(parsed.host) === normalizeAuthority(host);
}

/** 普通写接口的请求体上限。 */
const BODY_LIMIT_DEFAULT = 2 * 1024 * 1024;
/**
 * 导入接口的上限。
 *
 * 必须比默认值大得多：`full` 模式会把技能文件一起带进来，二进制经 base64 后
 * 膨胀约 33%。上限取 64 MB —— 足够覆盖常见的技能目录，同时仍能挡住
 * 「误把整个仓库当配置文件发过来」这类请求，避免内存被无上限占用。
 */
const BODY_LIMIT_IMPORT = 64 * 1024 * 1024;

/**
 * 请求体超限。
 *
 * 关键在于**把剩余字节读干净**再回包：如果中途停止读取就回 400，客户端往往
 * 还在上传，会先收到 ECONNRESET 而看不到我们精心准备的错误信息（表现为
 * 「导入大文件时界面直接报网络错误」）。所以超限后继续丢弃式读取，直到请求
 * 结束再回包。
 *
 * 但丢弃也不能无上限 —— 否则一个超大 body 就能拖住连接。因此设一个硬上限
 * （超限后再读 `DRAIN_FACTOR` 倍），超过就直接掐断连接，宁可让客户端看到
 * 网络错误，也不让服务端被拖垮。
 */
class BodyTooLargeError extends Error {
	constructor(limit) {
		super(`请求体过大（超过 ${Math.round(limit / 1024 / 1024)} MB）`);
	}
}

/** 超限后允许继续丢弃读取的倍数（相对上限）。 */
const DRAIN_FACTOR = 4;

/** 读取 JSON 请求体（默认上限 2 MB；导入接口另行放宽）。 */
async function readJsonBody(request, limit = BODY_LIMIT_DEFAULT) {
	const chunks = [];
	let size = 0;
	let exceeded = false;
	for await (const chunk of request) {
		size += chunk.length;
		if (exceeded) {
			// 已在丢弃阶段：只受硬上限约束。
			if (size > limit * DRAIN_FACTOR) {
				request.destroy();
				throw new BodyTooLargeError(limit);
			}
			continue;
		}
		if (size > limit) {
			exceeded = true;
			// 丢弃已收内容，释放内存；后续分片继续读到请求结束。
			chunks.length = 0;
			continue;
		}
		chunks.push(chunk);
	}
	if (exceeded) throw new BodyTooLargeError(limit);
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}

// ── 网关 ─────────────────────────────────────────────────────────────────────

class SkillMcpGateway {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config ?? {};
	}

	/** DSH 主目录。 */
	get dshHome() {
		return this.config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	}

	/** 当前 profile 目录。 */
	get profileDir() {
		const fromService = this.ctx.get?.("profileContext")?.dir;
		if (typeof fromService === "string" && fromService !== "") return fromService;
		if (typeof process.env.DSH_PROFILE_DIR === "string" && process.env.DSH_PROFILE_DIR !== "") {
			return process.env.DSH_PROFILE_DIR;
		}
		const profile = process.env.DSH_PROFILE ?? "desktop";
		return join(this.dshHome, "profiles", profile);
	}

	/**
	 * 要编辑的 patch 文件。
	 *
	 * 优先用 `configEditor.documentPath` —— 那是 DSH 自己认定的「该写哪个文件」，
	 * 能正确处理 home patch / CLI overlay 等情形；取不到再回退 profile 目录。
	 */
	get patchPath() {
		const documented = this.ctx.get?.("configEditor")?.documentPath;
		if (typeof documented === "string" && documented !== "") return documented;
		return join(this.profileDir, "cordis.patch.yml");
	}

	/** 计算技能根列表。 */
	async roots(cwd) {
		const anchor = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
		return buildRoots(anchor, { dshHome: this.dshHome });
	}

	// ── MCP ──────────────────────────────────────────────────────────────────

	/** 读取 patch 中的 MCP 行（受管 + 外部）。 */
	async readMcpRows() {
		const path = this.patchPath;
		const raw = await readPatchFile(path);
		const managed = extractManagedRows(raw);
		const all = listMcpPatchRows(raw);
		const managedIds = new Set(managed.map((row) => row.id).filter((id) => typeof id === "string"));
		const external = all.filter((row) => typeof row.id !== "string" || !managedIds.has(row.id));
		return { path, managed, external };
	}

	/** 受管行的归属名：优先行 id 前缀，其次 config.serverName。 */
	static rowOwner(row) {
		return serverNameFromRowId(row.id) ?? row.config?.serverName;
	}

	/**
	 * 取出受管行并定位其一 —— 「按 serverName 找一行」的所有入口共用。
	 * 找不到时按 `absentMessage` 报错，避免各调用方各写一套找法。
	 */
	async requireManagedRow(rawName, absentMessage) {
		const serverName = String(rawName ?? "");
		if (serverName === "") throw new Error("serverName 不能为空");
		const { managed } = await this.readMcpRows();
		const row = managed.find((candidate) => SkillMcpGateway.rowOwner(candidate) === serverName);
		if (row === undefined) throw new Error(absentMessage(serverName));
		return { managed, row, serverName };
	}

	/** 解析 loader 服务（inject 后 `ctx.loader` 可用；`ctx.get` 作为兜底）。 */
	get loaderService() {
		const direct = this.ctx.loader;
		if (direct !== undefined && typeof direct.entries === "function") return direct;
		const viaGet = this.ctx.get?.("loader");
		if (viaGet !== undefined && typeof viaGet.entries === "function") return viaGet;
		return undefined;
	}

	/** 在 loader 树里找一行条目。条目 id 可能带 `include:` 前缀，故按 patch id 与全 id 双匹配。 */
	loaderEntry(id) {
		const loader = this.loaderService;
		if (loader === undefined) return undefined;
		for (const entry of loader.entries()) {
			if (entry.id === id) return entry;
			if (entry.options?.id === id) return entry;
			if (typeof entry.id === "string" && entry.id.endsWith(`:${id}`)) return entry;
		}
		return undefined;
	}

	/** loader 条目 → 可读阶段名。 */
	phaseOf(entry) {
		const state = entry?.fiber?.state;
		return typeof state === "number" ? FIBER_PHASE[state] ?? null : null;
	}

	/** 当前 loader 条目摘要（诊断用，便于在界面确认某一行是否真的挂载了）。 */
	loaderSnapshot() {
		const loader = this.loaderService;
		if (loader === undefined) {
			return { error: "loader service unavailable", hasCtxLoader: this.ctx.loader !== undefined };
		}
		try {
			const all = [...loader.entries()];
			return {
				total: all.length,
				mcp: all
					.filter((entry) => typeof entry.options?.name === "string" && entry.options.name.includes("mcp-client"))
					.map((entry) => ({
						entryId: typeof entry.id === "string" ? entry.id : undefined,
						patchId: entry.options?.id,
						serverName: entry.options?.config?.serverName,
						disabled: entry.disabled === true,
						phase: this.phaseOf(entry)
					}))
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 某个 MCP 服务器当前注册的工具数。 */
	mcpToolCount(serverName) {
		const tools = this.ctx.get?.("tools");
		if (tools === undefined || typeof tools.schemas !== "function") return 0;
		const prefix = `mcp__${serverName}__`;
		const schemas = tools.schemas();
		return Array.isArray(schemas) ? schemas.filter((s) => typeof s?.name === "string" && s.name.startsWith(prefix)).length : 0;
	}

	/** patch 行 → 展示视图（脱敏，不含密钥值）。 */
	decorateMcpRow(row, managed, enabled) {
		const view = patchRowToView(row);
		if (view === undefined) return undefined;
		const entry = typeof row.id === "string" ? this.loaderEntry(row.id) : undefined;
		return {
			...view,
			enabled,
			managed,
			fiberPhase: this.phaseOf(entry),
			entryId: typeof entry?.id === "string" ? entry.id : undefined,
			toolCount: enabled ? this.mcpToolCount(view.serverName) : 0
		};
	}

	async listMcp() {
		const patchPath = this.patchPath;
		try {
			const { managed, external } = await this.readMcpRows();
			// 每行的 OAuth 状态随列表一起返回：界面不必为每个服务器各发一次请求。
			// 记录里含 token，所以只回 oauthView 的白名单字段。
			const oauthRecords = await loadOAuth(this.dshHome).catch(() => ({}));
			const withOAuth = (view) =>
				view === undefined
					? undefined
					: {
							...view,
							oauth: {
								...oauthView(oauthRecords[view.serverName]),
								// 行里已有手写的静态 Authorization 头时，OAuth 不是必需的。
								staticAuthorization:
									typeof view.headers?.Authorization === "string" && view.headers.Authorization !== ""
							}
						};
			const servers = [];
			for (const row of managed) {
				const view = withOAuth(this.decorateMcpRow(row, true, row.disabled !== true));
				if (view !== undefined) servers.push(view);
			}
			const externalServers = [];
			for (const row of external) {
				const view = withOAuth(this.decorateMcpRow(row, false, row.disabled !== true));
				if (view !== undefined) externalServers.push(view);
			}
			// 首字母排序（大小写不敏感）。受管行各自独立，排序不影响语义。
			return {
				servers: sortByName(servers, (server) => server.serverName),
				externalServers: sortByName(externalServers, (server) => server.serverName),
				duplicates: duplicateServerNames(managed, external),
				patch: { path: patchPath, ok: true, error: null },
				loaderRows: this.loaderSnapshot()
			};
		} catch (error) {
			return {
				servers: [],
				externalServers: [],
				duplicates: [],
				loaderRows: this.loaderSnapshot(),
				patch: { path: patchPath, ok: false, error: error instanceof Error ? error.message : String(error) }
			};
		}
	}

	/**
	 * 轮询 loader，直到条目满足条件（写入 patch 后 HMR 重挂载需要一点时间）。
	 *
	 * 注意：本函数在**热重载之前**已经运行的代码里执行。若此次写入改变了本插件
	 * 自身的模块（例如刚改完代码），本插件的 fiber 会被重建，这次轮询随之作废 ——
	 * 此时 `false` 是「宿主尚未完成重挂载」，不代表配置写错了。前端据此提示。
	 *
	 * 拿不到 loader 服务时**立即返回**，不做无谓轮询：没有 loader 就没有可轮询的
	 * 对象，等满超时只是让每次写入都白卡 8 秒（换电脑/精简宿主上都可能遇到）。
	 * 返回值语义不变 —— `false` = 无法确认已挂载，界面照实提示。
	 */
	async waitForLoader(id, predicate, timeoutMs = 8000) {
		if (this.loaderService === undefined) return false;
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const entry = this.loaderEntry(id);
			if (predicate(entry)) return true;
			await new Promise((r) => setTimeout(r, 200));
		}
		return false;
	}

	// ── MCP OAuth ────────────────────────────────────────────────────────────

	/**
	 * 某服务器的 OAuth 状态（不含任何 token）。
	 *
	 * 除了本地记录，还报告「行里是否已经有 Authorization 头」—— 因为
	 * 用户也可能自己手写了一个静态 Bearer，那种情况不需要走授权流程。
	 */
	async mcpOAuthStatus(payload) {
		const serverName = String(payload.serverName ?? "");
		if (serverName === "") throw new Error("缺少 serverName");
		const [record, rows] = await Promise.all([readOAuthRecord(this.dshHome, serverName), this.readMcpRows()]);
		const row = rows.managed.find((candidate) => SkillMcpGateway.rowOwner(candidate) === serverName);
		const headers = row?.config?.headers;
		const hasStaticAuth = headers !== null && typeof headers === "object" && typeof headers.Authorization === "string" && headers.Authorization !== "";
		return {
			serverName,
			...oauthView(record),
			// 行里已有静态 Authorization 头：说明用户自己配了 token，OAuth 流程不是必需的。
			staticAuthorization: hasStaticAuth
		};
	}

	/**
	 * 发起授权：发现端点、动态注册、开浏览器、等回调、换 token、写回行。
	 *
	 * 写回的是 `Authorization: Bearer <token>`。DSH 的 mcp-client 只把 headers
	 * 当静态头发送，所以这是让它认可 OAuth token 的唯一方式。
	 */
	async mcpOAuthAuthorize(payload) {
		const serverName = String(payload.serverName ?? "");
		if (serverName === "") throw new Error("缺少 serverName");
		const { managed, row } = await this.requireManagedRow(serverName, (name) => `MCP 行 "${name}" 不存在或不是本插件受管行`);
		const config = row.config !== null && typeof row.config === "object" ? row.config : {};
		if (config.transport !== "streamable-http") {
			throw new Error("只有 streamable-http 传输的服务器才需要 OAuth；stdio 服务器用环境变量传凭据");
		}
		const serverUrl = typeof config.url === "string" ? config.url : "";
		if (!/^https?:\/\//iu.test(serverUrl)) throw new Error("该行没有可用的 http(s) url，无法发起 OAuth");

		const { record } = await runAuthorization({
			serverUrl,
			serverName,
			dshHome: this.dshHome,
			scope: typeof payload.scope === "string" && payload.scope !== "" ? payload.scope : undefined,
			clientId: typeof payload.clientId === "string" && payload.clientId !== "" ? payload.clientId : undefined,
			clientSecret: typeof payload.clientSecret === "string" && payload.clientSecret !== "" ? payload.clientSecret : undefined,
			// 交给系统默认浏览器：宿主进程在 Electron 里，自己起窗口会抢焦点且难关闭。
			openUrl: async (url) => {
				const { spawn } = await import("node:child_process");
				const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
				const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
				spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
			}
		});

		// 把 token 写进受管行。保留用户已有的其它头，只覆盖 Authorization。
		const nextHeaders = { ...(config.headers ?? {}), Authorization: authorizationHeader(record) };
		const nextRow = { ...row, config: { ...config, headers: nextHeaders } };
		const nextRows = managed.map((candidate) => (candidate === row ? nextRow : candidate));
		await writeManagedRows(this.patchPath, nextRows);
		// 行内容变了 → HMR 会重挂这一行，新 token 随之生效。
		const reconciled = await this.waitForLoader(row.id, (entry) => entry !== undefined && entry.disabled !== true);
		return { serverName, ...oauthView(record), reconciled };
	}

	/** 用 refresh token 换新 token 并写回行（token 快过期时手动触发）。 */
	async mcpOAuthRefresh(payload) {
		const serverName = String(payload.serverName ?? "");
		if (serverName === "") throw new Error("缺少 serverName");
		const { managed, row } = await this.requireManagedRow(serverName, (name) => `MCP 行 "${name}" 不存在或不是本插件受管行`);
		const record = await refreshServer(this.dshHome, serverName);
		const config = row.config !== null && typeof row.config === "object" ? row.config : {};
		const nextRow = { ...row, config: { ...config, headers: { ...(config.headers ?? {}), Authorization: authorizationHeader(record) } } };
		await writeManagedRows(this.patchPath, managed.map((candidate) => (candidate === row ? nextRow : candidate)));
		const reconciled = await this.waitForLoader(row.id, (entry) => entry !== undefined && entry.disabled !== true);
		return { serverName, ...oauthView(record), reconciled };
	}

	/** 断开授权：删记录，并移除行里由我们写入的 Authorization 头。 */
	async mcpOAuthForget(payload) {
		const serverName = String(payload.serverName ?? "");
		if (serverName === "") throw new Error("缺少 serverName");
		const removed = await forgetOAuthRecord(this.dshHome, serverName);
		const { managed, row } = await this.readMcpRows().then(({ managed, external }) => {
			const found = managed.find((candidate) => SkillMcpGateway.rowOwner(candidate) === serverName);
			if (found === undefined) throw new Error(`MCP 行 "${serverName}" 不存在或不是本插件受管行`);
			return { managed, row: found, external };
		});
		const config = row.config !== null && typeof row.config === "object" ? row.config : {};
		const headers = { ...(config.headers ?? {}) };
		delete headers.Authorization;
		const nextRow = { ...row, config: { ...config, headers } };
		await writeManagedRows(this.patchPath, managed.map((candidate) => (candidate === row ? nextRow : candidate)));
		const reconciled = await this.waitForLoader(row.id, (entry) => entry !== undefined && entry.disabled !== true);
		return { serverName, removed, ...oauthView(undefined), reconciled };
	}


	async mcpSave(payload) {
		const input = normalizeServerInput(payload.input ?? payload);
		const previousName = typeof payload.previousServerName === "string" && payload.previousServerName !== ""
			? payload.previousServerName
			: input.serverName;
		const { managed, external } = await this.readMcpRows();

		for (const row of external) {
			if (row.config?.serverName === input.serverName) {
				throw new Error(`serverName "${input.serverName}" 已被外部 MCP 行（${String(row.id)}）占用，请直接编辑 cordis.patch.yml`);
			}
		}
		for (const row of managed) {
			const owner = SkillMcpGateway.rowOwner(row);
			if (owner === input.serverName && owner !== previousName) {
				throw new Error(`serverName "${input.serverName}" 已存在（受管行 ${String(row.id)}）`);
			}
		}

		const previous = managed.find((row) => SkillMcpGateway.rowOwner(row) === previousName);
		if (payload.previousServerName !== undefined && previous === undefined) {
			throw new Error(`要编辑的 MCP 行不存在："${previousName}"`);
		}

		// 密钥合并语义：页面永远拿不到已有密钥值（只拿到键名），因此编辑时
		// 不能整体替换 —— 否则用户没重新输入的那些密钥会被静默丢弃。
		// 规则：以旧值为底，`input.env` 覆盖同名键，`envRemoved` 删除键。
		if (previous !== undefined) {
			const prevConfig = previous.config !== null && typeof previous.config === "object" ? previous.config : {};
			const mergeSecrets = (field, removedField) => {
				const prevMap = prevConfig[field] !== null && typeof prevConfig[field] === "object" && !Array.isArray(prevConfig[field])
					? prevConfig[field]
					: {};
				const merged = { ...prevMap, ...(input[field] ?? {}) };
				const removed = Array.isArray(payload[removedField]) ? payload[removedField] : [];
				for (const key of removed) delete merged[key];
				input[field] = merged;
			};
			if (input.transport === "stdio" && prevConfig.transport === "stdio") mergeSecrets("env", "envRemoved");
			if (input.transport === "streamable-http" && prevConfig.transport === "streamable-http") {
				mergeSecrets("headers", "headerRemoved");
			}
		}

		const enabled = previous !== undefined ? previous.disabled !== true : payload.enabled !== false;
		const nextRow = toPatchRow(input, enabled);
		// 排序由 writeManagedRows 统一负责（所有写入路径的唯一收口）。
		const nextRows = managed.filter((row) => SkillMcpGateway.rowOwner(row) !== previousName);
		nextRows.push(nextRow);

		await writeManagedRows(this.patchPath, nextRows);
		const reconciled = await this.waitForLoader(nextRow.id, (entry) =>
			entry !== undefined && (enabled ? entry.disabled !== true : entry.disabled === true));
		const server = this.decorateMcpRow(nextRow, true, enabled);
		if (server === undefined) throw new Error("写入成功，但生成的 MCP 行无法解析");
		return { server, reconciled };
	}

	async mcpRemove(payload) {
		const { managed, row } = await this.requireManagedRow(
			payload.serverName,
			(name) => `MCP 行 "${name}" 不存在或不是本插件受管行（外部行请手动删除）`
		);
		await writeManagedRows(this.patchPath, managed.filter((candidate) => candidate !== row));
		const reconciled = await this.waitForLoader(row.id, (entry) => entry === undefined);
		return { ok: true, reconciled };
	}

	async mcpSetEnabled(payload) {
		const enabled = payload.enabled === true;
		const { managed, row } = await this.requireManagedRow(
			payload.serverName,
			(name) => `MCP 行 "${name}" 不存在或不是本插件受管行`
		);
		if (enabled) delete row.disabled;
		else row.disabled = true;
		await writeManagedRows(this.patchPath, managed);
		const reconciled = await this.waitForLoader(row.id, (entry) =>
			entry !== undefined && (enabled ? entry.disabled !== true : entry.disabled === true));
		const server = this.decorateMcpRow(row, true, enabled);
		if (server === undefined) throw new Error("写入成功，但生成的 MCP 行无法解析");
		return { server, reconciled };
	}

	// ── Skills ───────────────────────────────────────────────────────────────

	async listSkills(cwd) {
		const roots = await this.roots(cwd);
		const entries = await collectSkillEntries(roots);

		// 注册表视图：包含插件注册的（无文件）技能与官方提供方发现的技能。
		// 用它补齐 frontmatter 之外的真实调用策略。取不到时降级为纯文件视图。
		let registered = [];
		let registryError;
		const skills = this.ctx.get?.("skills");
		if (skills !== undefined && typeof skills.list === "function") {
			try {
				registered = await skills.list({ cwd: typeof cwd === "string" ? cwd : undefined });
			} catch (error) {
				registryError = error instanceof Error ? error.message : String(error);
			}
		}
		const registeredByName = new Map();
		for (const skill of registered) {
			if (typeof skill?.name === "string" && !registeredByName.has(skill.name)) registeredByName.set(skill.name, skill);
		}

		const rootList = roots.map((root) => ({
			path: root.path,
			source: root.source,
			rank: root.rank,
			projectRoot: root.projectRoot,
			exists: false
		}));
		await Promise.all(
			rootList.map(async (root) => {
				root.exists = await pathExists(root.path);
			})
		);

		const files = entries.map((entry) => {
			const skill = registeredByName.get(entry.name);
			return {
				name: entry.name,
				description: entry.description,
				whenToUse: entry.whenToUse,
				enabled: entry.enabled,
				kind: entry.kind,
				file: entry.file,
				source: entry.source,
				projectRoot: entry.projectRoot,
				rel: entry.rel,
				modelInvocable: skill?.invocation?.modelInvocable ?? entry.modelInvocable,
				userInvocable: skill?.invocation?.userInvocable ?? entry.userInvocable,
				valid: entry.valid !== false,
				inRegistry: skill !== undefined,
				pluginProvided: false,
				toggleable: true
			};
		});

		// 注册表里有、文件系统里没有的 → 插件注册的只读技能。
		const fileNames = new Set(files.map((item) => item.name));
		const pluginSkills = registered
			.filter((skill) => typeof skill?.name === "string" && !fileNames.has(skill.name))
			.map((skill) => ({
				name: skill.name,
				description: skill.description ?? "",
				enabled: true,
				kind: "plugin",
				source: skill.source ?? "plugin",
				rel: "",
				modelInvocable: skill.invocation?.modelInvocable ?? true,
				userInvocable: skill.invocation?.userInvocable ?? true,
				inRegistry: true,
				pluginProvided: true,
				toggleable: false
			}));

		return {
			skills: sortByName([...files, ...pluginSkills], (skill) => skill.name),
			roots: rootList,
			registryError,
			registryCount: registered.length
		};
	}

	/** 定位一个可切换的文件技能（名字为空即报错，三个调用方都依赖这一点）。 */
	async locateSkill(cwd, rawName) {
		const name = String(rawName ?? "");
		if (name === "") throw new Error("技能名不能为空");
		const roots = await this.roots(cwd);
		const entries = await collectSkillEntries(roots);
		const entry = winnerEntry(entries, name);
		if (entry === undefined) throw new Error(`未找到文件技能 "${name}"（可能是插件注册的技能，无法启用/停用）`);
		return { entry, roots, name };
	}

	async skillSetEnabled(payload) {
		const { entry, name } = await this.locateSkill(payload.cwd, payload.name);
		const changed = await setSkillEnabled(entry, payload.enabled === true);
		return { name, enabled: entry.enabled, changed, file: entry.file };
	}

	async skillRemove(payload) {
		const { entry, name } = await this.locateSkill(payload.cwd, payload.name);
		await removeSkill(entry);
		return { name, removed: true, kind: entry.kind };
	}

	async skillRead(payload) {
		const { entry, name } = await this.locateSkill(payload.cwd, payload.name);
		const content = await readSkillText(entry.file);
		return { name, file: entry.file, kind: entry.kind, enabled: entry.enabled, content };
	}

	/** 新建或覆盖一个技能。 */
	async skillWrite(payload) {
		const content = typeof payload.content === "string" ? payload.content : "";
		const validation = validateFrontmatter(content);
		if (!validation.ok) throw new Error(`技能内容不合规：${validation.error}`);
		const kind = normalizeKind(payload.kind);
		const roots = await this.roots(payload.cwd);
		// 目标根：显式指定则必须在已知根之内；否则用优先级最高的已存在根。
		const target = this.resolveTargetRoot(roots, payload.rootPath);
		const previousName = typeof payload.previousName === "string" && payload.previousName !== "" ? payload.previousName : undefined;

		// 改名：先移除旧落盘项，避免同一技能留下两份。
		if (previousName !== undefined && previousName !== validation.name) {
			const entries = await collectSkillEntries(roots);
			const old = winnerEntry(entries, previousName);
			if (old !== undefined) await removeSkill(old);
		}
		const path = await writeSkillFile(target, validation.name, kind, content);
		// 清掉可能存在的停用孪生项，保证写入即启用。
		await removeDisabledTwin(path, kind).catch(() => {});
		return { name: validation.name, path, kind, rootPath: target.path };
	}

	/** 目标根：显式 rootPath 必须落在已知根内；否则选第一个已存在的根。 */
	resolveTargetRoot(roots, rootPath) {
		if (typeof rootPath === "string" && rootPath.trim() !== "") {
			const wanted = resolve(rootPath.trim());
			const key = process.platform === "win32" ? wanted.toLowerCase() : wanted;
			const found = roots.find((root) => {
				const rootKey = process.platform === "win32" ? root.path.toLowerCase() : root.path;
				return rootKey === key;
			});
			if (found === undefined) throw new Error(`目标技能根不在已知根列表中：${wanted}`);
			return found;
		}
		// 默认写到用户 .dsh/skills（最常用于全局技能）。
		const userDsh = roots.find((root) => root.source === "user-dsh");
		if (userDsh !== undefined) return userDsh;
		const existing = roots.find((root) => root.source !== undefined);
		if (existing === undefined) throw new Error("没有可用的技能根");
		return existing;
	}

	async skillInstall(payload) {
		const roots = await this.roots(payload.cwd);
		const target = this.resolveTargetRoot(roots, payload.rootPath);
		const kind = normalizeKind(payload.kind);
		return installFromRepo({
			url: payload.url,
			ref: payload.ref,
			subPath: payload.subPath,
			rootPath: target.path,
			kind,
			roots,
			dshHome: this.dshHome,
			proxy: await this.proxyUrl()
		});
	}

	async skillUpdate(payload) {
		const label = String(payload.label ?? "");
		const sources = await loadSources(this.dshHome);
		const source = sources.find((entry) => entry.label === label);
		if (source === undefined) throw new Error(`未找到已安装来源 "${label}"`);
		const roots = await this.roots(payload.cwd);
		return installFromRepo({
			url: source.url,
			ref: source.ref,
			subPath: source.subPath,
			rootPath: source.rootPath,
			kind: source.kind ?? "bundle",
			roots,
			dshHome: this.dshHome,
			proxy: await this.proxyUrl()
		});
	}

	async skillCheckUpdates() {
		const [sources, proxy] = await Promise.all([loadSources(this.dshHome), this.proxyUrl()]);
		const results = await Promise.all(
			sources.map(async (source) => ({ label: source.label, ...(await checkSourceUpdate(source, proxy)) }))
		);
		results.sort((a, b) => compareName(a.label, b.label));
		return { results, git: await checkGitAvailable() };
	}

	async skillForgetSource(payload) {
		const removed = await forgetSource(this.dshHome, String(payload.label ?? ""));
		return { removed };
	}

	/**
	 * 通知 skill 提供方：磁盘上的技能变了，请失效目录缓存。
	 *
	 * 由路由表里标了 `skills: true` 的接口在成功后调用。提供方未注册时
	 * `onSkillsChanged` 为 undefined，这里静默跳过 —— 插件不该因为
	 * 缺少 skills 服务而报错。
	 */
	skillsChanged() {
		try {
			this.onSkillsChanged?.();
		} catch (error) {
			this.ctx.logger?.warn?.(`dsh-skill-mcp-tool: 失效 skill 目录缓存失败：${String(error)}`);
		}
	}

	// ── 配置打包（导出 / 导入）───────────────────────────────────────────────

	/** 已安装技能 → 来源标签的反向索引（判断某技能能否用配方还原）。 */
	sourceIndex(sources) {
		const bySkill = new Map();
		for (const source of Array.isArray(sources) ? sources : []) {
			for (const name of Array.isArray(source?.skills) ? source.skills : []) {
				// 同一技能被多个来源覆盖时保留第一个：后面的通常是更新记录。
				if (!bySkill.has(name)) bySkill.set(name, source);
			}
		}
		return bySkill;
	}

	/**
	 * 导出配置包。
	 *
	 * `skills` 参数有两种取值：
	 *   - `recipe`（默认）：能回溯到 Git 来源的技能只存「配方」（仓库 + 提交 +
	 *     落盘形态），导出文件通常只有几 KB；导入时按配方重新克隆。
	 *   - `full`：连文件内容一起打包（base64 承载二进制），导入无需联网。
	 *
	 * 无法回溯来源的技能**无论哪种模式都带内容** —— 否则换电脑后它就丢了。
	 * 这一点无法由用户选错，所以不交给界面决定。
	 */
	async exportBundle(payload) {
		const mode = payload?.skills === PAYLOAD_MODES.full ? PAYLOAD_MODES.full : PAYLOAD_MODES.recipe;
		const includeSecrets = payload?.includeSecrets === true;

		const roots = await this.roots(payload?.cwd);
		const entries = await collectSkillEntries(roots);
		// 只导出胜出条目：同名技能在多个根里只会有一个是生效的。
		const winners = new Map();
		for (const entry of entries) {
			const current = winners.get(entry.name);
			if (current === undefined) winners.set(entry.name, entry);
			else if (winnerEntry([current, entry], entry.name) === entry) winners.set(entry.name, entry);
		}

		const sources = await loadSources(this.dshHome);
		const bySkill = this.sourceIndex(sources);
		// 插件自己的设置（目前只有代理）也要跟着走，否则换电脑后还得再填一次。
		const settings = await loadSettings(this.dshHome);

		const skills = [];
		const skipped = [];
		for (const entry of [...winners.values()].sort((a, b) => compareName(a.name, b.name))) {
			const source = bySkill.get(entry.name);
			const common = { name: entry.name, kind: entry.kind, enabled: entry.enabled, description: entry.description };
			// 有来源 → 可用配方；没有来源 → 必须带内容。
			const useRecipe = mode === PAYLOAD_MODES.recipe && source !== undefined;
			if (useRecipe) {
				skills.push({
					...common,
					payload: "recipe",
					origin: {
						label: source.label,
						url: source.url,
						ref: source.ref ?? "",
						subPath: source.subPath ?? "",
						commit: source.commit ?? "",
						kind: source.kind ?? entry.kind
					}
				});
				continue;
			}

			const read = await readSkillFiles(dirname(entry.file), {
				singleFile: entry.kind === "flat" ? entry.file : undefined
			});
			skipped.push(...read.skipped.map((item) => ({ skill: entry.name, ...item })));
			skills.push({
				...common,
				payload: "full",
				// 不可重拉时也记下来源，便于日后参考（导入仍走内容还原）。
				// 这里刻意不带 kind：完整内容模式靠 files 还原，origin 仅作参考，
				// 保持与既有导出的字段完全一致。
				origin:
					source === undefined
						? undefined
						: { label: source.label, url: source.url, ref: source.ref ?? "", subPath: source.subPath ?? "", commit: source.commit ?? "" },
				files: read.files,
				skipped: read.skipped
			});
		}

		// MCP：默认脱敏（只给键名）；显式勾选才写入明文值。
		const { managed } = await this.readMcpRows();
		const servers = managed
			.map((row) => this.exportMcpRow(row, includeSecrets))
			.filter((server) => server !== undefined);

		const bundle = buildBundle({
			skills,
			sources,
			mcp: { servers },
			// 代理地址可能内嵌口令，与 MCP 密钥同一条规矩：默认脱敏。
			settings: { proxy: { enabled: settings.proxy.enabled, url: includeSecrets ? settings.proxy.url : redactProxyUrl(settings.proxy.url) } },
			options: { skills: mode, includeSecrets },
			generator: { plugin: name, version: this.pluginVersion }
		});

		const text = `${JSON.stringify(bundle, null, 2)}\n`;
		return {
			bundle,
			text,
			bytes: Buffer.byteLength(text, "utf8"),
			filename: this.bundleFilename(),
			skipped,
			summary: {
				skills: skills.length,
				recipeSkills: skills.filter((s) => s.payload === "recipe").length,
				fullSkills: skills.filter((s) => s.payload === "full").length,
				servers: servers.length,
				sources: sources.length,
				includeSecrets,
				// 有多少服务器带着「需要令牌」的键 —— 换电脑后要重填的清单。
				// 注意读的是导出条目的 env/headers（键名集合），不是 view 的 envKeys。
				serversNeedingSecrets: includeSecrets
					? 0
					: servers.filter((s) => Object.keys(s.env ?? {}).length + Object.keys(s.headers ?? {}).length > 0).length
			}
		};
	}

	/** 导出文件名：带日期，便于同时保存多份快照。 */
	bundleFilename() {
		const now = new Date();
		const pad = (value) => String(value).padStart(2, "0");
		return `dsh-skill-mcp-tool-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
	}

	/**
	 * 受管 MCP 行 → 导出条目。
	 * `includeSecrets=false` 时用空串占位，只保留键名（导入后界面可提示需重填）。
	 */
	exportMcpRow(row, includeSecrets) {
		const view = patchRowToView(row);
		if (view === undefined) return undefined;
		const config = row.config !== null && typeof row.config === "object" ? row.config : {};
		const pick = (map, keys) => {
			if (map === null || typeof map !== "object") return undefined;
			const out = {};
			for (const key of keys ?? []) {
				const value = map[key];
				if (value === undefined) continue;
				// 脱敏时留空串：保留键名让导入方知道「这里需要一个值」。
				out[key] = includeSecrets ? value : "";
			}
			return Object.keys(out).length > 0 ? out : undefined;
		};
		const secretKeys = [...(view.envKeys ?? []), ...(view.headerKeys ?? [])];
		return {
			serverName: view.serverName,
			transport: view.transport,
			enabled: view.enabled,
			command: view.command,
			args: view.args,
			cwd: view.cwd,
			url: view.url,
			env: pick(config.env, view.envKeys),
			headers: pick(config.headers, view.headerKeys),
			toolCallTimeoutMs: view.toolCallTimeoutMs,
			failOnStartupError: view.failOnStartupError,
			reconnect: view.reconnect,
			// 让导入方一眼看出「这个条目里有没有真密钥」。
			hasSecrets: includeSecrets && secretKeys.length > 0
		};
	}

	/** 当前插件版本（写进导出包便于排查）；可用 config.pluginVersion 覆盖。 */
	get pluginVersion() {
		return this.config.pluginVersion ?? PLUGIN_VERSION;
	}

	/**
	 * 预检导入：只读，不写任何东西。
	 *
	 * 逐条算出「将会做什么」，用户确认后才执行 —— 换电脑时最不能接受的是
	 * 导入到一半失败，因此先把冲突、缺依赖、需重填的令牌都摊开。
	 */
	async importPlan(payload) {
		const parsed = parseBundle(typeof payload?.text === "string" ? payload.text : "");
		if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };

		const { bundle, stats } = parsed;
		const roots = await this.roots(payload?.cwd);
		const entries = await collectSkillEntries(roots);
		const existingSkills = new Set(entries.map((entry) => entry.name));
		const { managed, external } = await this.readMcpRows();
		const existingServers = new Set(
			[...managed, ...external].map((row) => SkillMcpGateway.rowOwner(row)).filter((owner) => typeof owner === "string")
		);
		const existingSources = new Set((await loadSources(this.dshHome)).map((source) => source.label));
		const git = await checkGitAvailable();
		// 代理：配置文件里带的代理会覆盖本机设置 —— 先在预检里说清楚，
		// 否则用户会以为「只是导入了技能」，结果网络路径被悄悄改掉。
		// 导出时未含密钥 → 地址里是 `***`，与本机已存口令合并后再比，避免误报「有变化」。
		const localProxy = (await loadSettings(this.dshHome)).proxy;
		const incomingProxy = {
			enabled: bundle.settings.proxy.enabled,
			url: mergeProxyUrl(bundle.settings.proxy.url, localProxy.url)
		};
		const proxyChanged = incomingProxy.enabled !== localProxy.enabled || incomingProxy.url !== localProxy.url;

		const skills = bundle.skills.map((skill) => {
			const present = existingSkills.has(skill.name);
			const needsGit = skill.payload === "recipe";
			const blocked = needsGit && git === undefined ? "本机没有 git，无法按配方重新拉取" : undefined;
			return {
				name: skill.name,
				payload: skill.payload,
				enabled: skill.enabled,
				present,
				action: present ? "overwrite" : "create",
				origin: skill.origin?.label,
				blocked,
				conflict: present ? "同名技能已存在，导入将覆盖" : undefined
			};
		});

		const servers = bundle.mcp.servers.map((server) => {
			const present = existingServers.has(server.serverName);
			const externalClash = external.some((row) => SkillMcpGateway.rowOwner(row) === server.serverName);
			const secretKeys = [...Object.keys(server.env ?? {}), ...Object.keys(server.headers ?? {})];
			return {
				serverName: server.serverName,
				transport: server.transport,
				enabled: server.enabled,
				present,
				action: present ? "overwrite" : "create",
				blocked: externalClash ? "同名服务器由其他插件/手写行维护，本插件不接管" : undefined,
				conflict: present ? "同名服务器已存在，导入将覆盖配置" : undefined,
				// 导出时未含明文 → 键名会以空串落盘，导入后需人工补值。
				needsSecrets: server.hasSecrets === true ? [] : secretKeys
			};
		});

		return {
			ok: true,
			errors: [],
			warnings: parsed.warnings,
			meta: { exportedAt: bundle.exportedAt, generator: bundle.generator, version: bundle.version },
			stats,
			gitAvailable: git !== undefined,
			skills,
			servers,
			sources: bundle.sources.map((source) => ({ label: source.label, present: existingSources.has(source.label) })),
			// 代理是否会被改动：界面据此提示「网络设置也会被覆盖」。
			proxy: {
				changed: proxyChanged,
				current: proxyView(localProxy),
				incoming: proxyView(incomingProxy),
				// 导出时未含密钥 → 口令需要人工补填（`***` 已按本机口令合并，此处即最终结果）。
				needsPassword: !bundle.options.includeSecrets && bundle.settings.proxy.url.includes(REDACTED) && localProxy.url === ""
			},
			// 会不会改动磁盘/配置的总体判断，让界面能给出准确的确认文案。
			willWrite: skills.length > 0 || servers.some((server) => server.blocked === undefined) || proxyChanged,
			blockedCount: skills.filter((s) => s.blocked !== undefined).length + servers.filter((s) => s.blocked !== undefined).length
		};
	}

	/**
	 * 执行导入。
	 *
	 * 逐条进行并收集结果 —— 单条失败不中断整体，否则用户会卡在「导了一半」
	 * 且不知道剩下什么。返回值里每条都有 ok/error，界面据此展示。
	 *
	 * 顺序：先技能（可能耗时：配方要克隆），再 MCP（写配置触发 HMR），
	 * 最后来源记录。MCP 放最后是因为它的写入会触发宿主重挂载，
	 * 让耗时的克隆先做完，避免与重挂载交错。
	 */
	async applyImport(payload) {
		const parsed = parseBundle(typeof payload?.text === "string" ? payload.text : "");
		if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings, skills: [], servers: [] };

		const { bundle } = parsed;
		const roots = await this.roots(payload?.cwd);
		const skills = [];
		const servers = [];

		// ── 0. 代理设置 ────────────────────────────────────────────────────
		//
		// 必须**先于**下面的克隆执行：换新电脑导入时本机往往正是「直连不通」的
		// 网络环境，配置文件里带的代理就是用来救这一下的。晚一步设置，
		// 配方技能的克隆会先失败一遍。
		const localProxy = (await loadSettings(this.dshHome)).proxy;
		const incomingProxy = {
			enabled: bundle.settings.proxy.enabled,
			url: normalizeProxyUrl(mergeProxyUrl(bundle.settings.proxy.url, localProxy.url))
		};
		let proxyApplied = false;
		try {
			// 配置包里没带代理（老版本导出、或导出时未启用）就保留本机设置不动。
			if (incomingProxy.url !== "" || bundle.settings.proxy.enabled !== localProxy.enabled) {
				await saveSettings(this.dshHome, { proxy: incomingProxy });
				proxyApplied = true;
			}
		} catch (error) {
			skills.push({ name: "(代理设置)", ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		const proxy = incomingProxy.enabled && incomingProxy.url !== "" ? incomingProxy.url : "";

		// ── 1. 技能 ────────────────────────────────────────────────────────
		for (const skill of bundle.skills) {
			try {
				if (skill.payload === "recipe") {
					// 配方：按记录的仓库/子目录重新克隆，落到与原来同一类根下。
					const target = this.resolveTargetRoot(roots, payload?.rootPath);
					const outcome = await installFromRepo({
						url: skill.origin.url,
						ref: skill.origin.ref ?? "",
						subPath: skill.origin.subPath ?? "",
						rootPath: target.path,
						kind: normalizeKind(skill.origin.kind ?? skill.kind),
						roots,
						dshHome: this.dshHome,
						proxy
					});
					// 导入的启用状态可能与仓库默认不同：落盘后按导出时状态对齐。
					if (skill.enabled === false) {
						const entries = await collectSkillEntries(roots);
						const entry = winnerEntry(entries, skill.name);
						if (entry !== undefined) await setSkillEnabled(entry, false);
					}
					skills.push({
						name: skill.name,
						ok: true,
						via: "recipe",
						// 上游仓库可能已经变了：如实报告实际拿到的提交。
						commit: outcome.commit,
						requestedCommit: skill.origin.commit,
						drifted: skill.origin.commit !== "" && outcome.commit !== "" && outcome.commit !== skill.origin.commit,
						enabled: skill.enabled
					});
					continue;
				}

				// 完整内容：直接还原文件。
				//
				// 落点要区分形态：目录束的根是 `<root>/<name>/`（SKILL.md 在它里面），
				// 平铺单文件的根是 `<root>/`（文件本身是 `<name>.md`）。
				// skillTargetPath 返回的是**文件**路径，目录束时不能直接当目录用
				// ——否则文件会被写进 `SKILL.md/` 目录里。
				const target = this.resolveTargetRoot(roots, payload?.rootPath);
				const kind = normalizeKind(skill.kind);
				const dir = kind === "flat" ? target.path : join(target.path, skill.name);
				const written = await writeSkillFiles(dir, skill.files ?? []);
				// 启用状态：目录束靠改名 SKILL.md，平铺靠改名 <name>.md。
				const entries = await collectSkillEntries(roots);
				const entry = winnerEntry(entries, skill.name);
				if (entry !== undefined && skill.enabled === false) await setSkillEnabled(entry, false);
				skills.push({ name: skill.name, ok: true, via: "content", files: written, enabled: skill.enabled });
			} catch (error) {
				skills.push({ name: skill.name, ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}

		// ── 2. MCP 服务器（写受管块，触发 HMR 重挂载）─────────────────────
		for (const server of bundle.mcp.servers) {
			try {
				const result = await this.mcpSave({
					input: {
						serverName: server.serverName,
						transport: server.transport,
						command: server.command,
						args: server.args,
						cwd: server.cwd,
						url: server.url,
						env: server.env,
						headers: server.headers,
						toolCallTimeoutMs: server.toolCallTimeoutMs,
						failOnStartupError: server.failOnStartupError,
						reconnect: server.reconnect
					},
					enabled: server.enabled !== false
				});
				servers.push({ serverName: server.serverName, ok: true, reconciled: result.reconciled, enabled: server.enabled !== false });
			} catch (error) {
				servers.push({ serverName: server.serverName, ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}

		// ── 3. 来源记录：合并进现有记录（按 label 去重，导入的优先）────────
		let sourcesMerged = 0;
		try {
			const existing = await loadSources(this.dshHome);
			const byLabel = new Map(existing.map((source) => [source.label, source]));
			for (const source of bundle.sources) {
				byLabel.set(source.label, source);
				sourcesMerged++;
			}
			const merged = [...byLabel.values()].sort((a, b) => compareName(a?.label, b?.label));
			await saveSources(this.dshHome, merged);
		} catch (error) {
			sourcesMerged = -1;
			skills.push({ name: "(来源记录)", ok: false, error: error instanceof Error ? error.message : String(error) });
		}

		return {
			ok: true,
			errors: [],
			warnings: parsed.warnings,
			skills,
			servers,
			sourcesMerged,
			// 代理设置是否被配置包改写 —— 导入后需要明确告知的一次环境变更。
			proxy: { applied: proxyApplied, active: proxyView({ enabled: incomingProxy.enabled, url: incomingProxy.url }) },
			summary: {
				skillsOk: skills.filter((s) => s.ok).length,
				skillsFailed: skills.filter((s) => !s.ok).length,
				serversOk: servers.filter((s) => s.ok).length,
				serversFailed: servers.filter((s) => !s.ok).length,
				// 上游漂移的技能数：提示用户「拿到的不是导出那一刻的版本」。
				drifted: skills.filter((s) => s.drifted).length
			}
		};
	}

	// ── 代理设置 ─────────────────────────────────────────────────────────────

	/** 设置文件路径（与 `sources.json` 同级，刻意不碰 patch 文件）。 */
	get settingsPath() {
		return join(this.dshHome, "skill-mcp-tool", "settings.json");
	}

	/**
	 * 当前生效的代理地址；未启用/未填写时空串。
	 *
	 * 空串是**有意义的**：调用方据此不传 `-c http.proxy`，
	 * 于是沿用用户自己的全局 git 配置，而不是替用户把代理清掉。
	 */
	async proxyUrl() {
		return activeProxyUrl(this.dshHome);
	}

	/** 读取代理设置（口令脱敏后回给浏览器）。 */
	async proxyGet() {
		const settings = await loadSettings(this.dshHome);
		return {
			proxy: proxyView(settings.proxy),
			// 「当前实际会不会走代理」—— 与 url 区分开：勾了启用但没填地址时不生效。
			// 同样必须脱敏：这是要回给浏览器的字段。
			active: redactProxyUrl(await this.proxyUrl()),
			settingsPath: this.settingsPath
		};
	}

	/**
	 * 保存代理设置。
	 *
	 * 提交串里的 `***` 会还原成已存口令（见 `mergeProxyUrl`）—— 输入框显示的
	 * 是脱敏串，用户「看一眼再保存」不该把口令清掉。
	 */
	async proxySave(payload) {
		// 要求显式给出 `proxy` 对象：`enabled` 只在**明确为 true** 时启用，
		// 因此一个空的/畸形的请求体会静默地把代理关掉。宁可报错，也不要让
		// 「谁误发了一次 POST」变成「代理悄悄没了」。
		const input = payload?.proxy;
		if (input === null || typeof input !== "object" || Array.isArray(input)) {
			throw new Error("缺少 proxy 字段（应为 { enabled, url }）");
		}
		const url = normalizeProxyUrl(mergeProxyUrl(input.url, (await loadSettings(this.dshHome)).proxy.url));
		const enabled = input.enabled === true;
		// 勾了启用却没填地址是常见的手滑，直接拒绝比静默「启用了空代理」清楚。
		if (enabled && url === "") throw new Error("已勾选启用代理，但代理地址为空");
		await saveSettings(this.dshHome, { proxy: { enabled, url } });
		return { proxy: proxyView({ enabled, url }), active: redactProxyUrl(enabled ? url : ""), settingsPath: this.settingsPath };
	}

	/**
	 * 用给定地址（默认当前设置）试探一次远端可达性。
	 *
	 * 存在的理由：安装失败时用户最需要知道的是「代理没用」还是「仓库/引用不对」。
	 * 启用代理时**直连与走代理各测一次**，两个结果一起给出 —— 这样一次点击就能
	 * 回答「是网络路径的问题，还是仓库本身的问题」。未启用代理时只测一次：
	 * 两次探针会完全等价，白等一轮。
	 */
	async proxyTest(payload) {
		const stored = await loadSettings(this.dshHome);
		const input = payload?.proxy ?? {};
		const candidate = normalizeProxyUrl(mergeProxyUrl(input.url, stored.proxy.url));
		const enabled = input.enabled === undefined ? stored.proxy.enabled : input.enabled === true;
		const proxy = enabled ? candidate : "";
		// 缺省探一个稳定存在的小仓库：够用来区分「网络通不通」。
		const url = typeof payload?.url === "string" && payload.url.trim() !== "" ? payload.url : "https://github.com/octocat/Hello-World";

		const viaProxy = proxy === "" ? undefined : await probeRemote(url, proxy);
		const direct = await probeRemote(url, "");
		return {
			url,
			proxy: proxyView({ enabled: proxy !== "", url: candidate }),
			viaProxy,
			direct
		};
	}

	// ── 插件自身更新 ─────────────────────────────────────────────────────────

	/** 本插件的身份（版本 + 上游仓库地址），界面据此显示版本徽标。 */
	pluginInfo() {
		return {
			name: PLUGIN_MANIFEST.name,
			version: PLUGIN_VERSION,
			repository: repoUrlOf(PLUGIN_MANIFEST) ?? null
		};
	}

	/**
	 * 检查上游有没有更新。
	 *
	 * 走插件自己的「Git 代理」设置：这里和技能安装是同一条网络路径，
	 * 用户配了代理而检查绕过去，就会出现「装得上、查不了」的怪状态。
	 */
	async updateCheck() {
		return checkPluginUpdate({
			name: PLUGIN_MANIFEST.name,
			version: PLUGIN_VERSION,
			repositoryUrl: repoUrlOf(PLUGIN_MANIFEST),
			profileDir: this.profileDir,
			proxy: await this.proxyUrl()
		});
	}

	/**
	 * 一键更新：起一个后台 pnpm 子进程重装同一个 spec。
	 *
	 * 刻意不在这里卸载/重挂自己（理由见 self-update.js 的模块注释）。
	 * 返回后界面轮询 `update/status`，装完提示重启 DSH 生效。
	 */
	async updateApply() {
		return startPluginUpdate({
			name: PLUGIN_MANIFEST.name,
			version: PLUGIN_VERSION,
			profileDir: this.profileDir,
			dshHome: this.dshHome,
			proxy: await this.proxyUrl()
		});
	}

	/** 当前更新进度（含日志尾部，方便就地排查失败原因）。 */
	async updateStatus() {
		const [state, log] = await Promise.all([readUpdateState(this.dshHome), readUpdateLog(this.dshHome)]);
		return { plugin: this.pluginInfo(), state, log };
	}

	// ── 汇总 ─────────────────────────────────────────────────────────────────
	async state(payload) {
		const cwd = payload.cwd;
		const [skills, mcp, sources, git, proxy] = await Promise.all([
			this.listSkills(cwd).catch((error) => ({ skills: [], roots: [], error: error instanceof Error ? error.message : String(error) })),
			this.listMcp(),
			loadSources(this.dshHome)
				.catch(() => [])
				.then((list) => sortByName(list, (source) => source?.label)),
			checkGitAvailable(),
			this.proxyGet()
		]);
		return {
			skills,
			mcp,
			sources,
			proxy,
			// 面板顶部要显示「当前版本」，随主状态一起带回，省掉一次往返。
			plugin: this.pluginInfo(),
			environment: {
				git: git ?? null,
				patchPath: this.patchPath,
				profileDir: this.profileDir,
				dshHome: this.dshHome,
				sourcesFile: join(this.dshHome, "skill-mcp-tool", "sources.json")
			}
		};
	}
}

/** 删除与某技能路径配对的 `.disabled` 孪生项。 */
async function removeDisabledTwin(path, kind) {
	const { rm } = await import("node:fs/promises");
	if (kind === "flat") {
		await rm(`${path}${DISABLED_SUFFIX}`, { force: true });
		return;
	}
	// 目录束：技能目录下的 SKILL.md.disabled
	await rm(join(path, "..", `SKILL.md${DISABLED_SUFFIX}`), { force: true });
}

// ── 路由挂载 ─────────────────────────────────────────────────────────────────

/**
 * 声明式路由表：path → `{ handle, readOnly?, bodyLimit?, skills? }`。
 *
 * `bodyLimit` 只在需要时覆盖默认值（导入可能带上 MB 级的技能内容）。
 * `readOnly` 表示允许无请求体的 GET —— 只给真正无副作用的接口。
 * `skills: true` 表示该接口会改动磁盘上的技能，成功后就地失效 skill 目录缓存，
 * 使 `/` 菜单立即反映变化。集中在这里声明，比在每个方法里各写一遍更不容易漏。
 *
 * 注意 `bundle/export` **不**标 readOnly：它需要 `skills` / `includeSecrets`
 * 参数，走 POST。用 GET 会拿到 405，这是刻意的（避免出现「查询串控制导出
 * 内容」这种容易被误用的接口）。
 */
const ROUTES = {
	state: { handle: (gw, payload) => gw.state(payload), readOnly: true },
	"skill/set-enabled": { handle: (gw, payload) => gw.skillSetEnabled(payload), skills: true },
	"skill/remove": { handle: (gw, payload) => gw.skillRemove(payload), skills: true },
	"skill/read": { handle: (gw, payload) => gw.skillRead(payload) },
	"skill/write": { handle: (gw, payload) => gw.skillWrite(payload), skills: true },
	"skill/install": { handle: (gw, payload) => gw.skillInstall(payload), skills: true },
	"skill/update": { handle: (gw, payload) => gw.skillUpdate(payload), skills: true },
	"skill/check-updates": { handle: (gw) => gw.skillCheckUpdates() },
	"skill/forget-source": { handle: (gw, payload) => gw.skillForgetSource(payload) },
	"mcp/save": { handle: (gw, payload) => gw.mcpSave(payload) },
	"mcp/remove": { handle: (gw, payload) => gw.mcpRemove(payload) },
	"mcp/set-enabled": { handle: (gw, payload) => gw.mcpSetEnabled(payload) },
	"mcp/list": { handle: (gw) => gw.listMcp(), readOnly: true },
	// MCP OAuth：状态只读；发起授权要开浏览器并写回行，必须 POST。
	"mcp/oauth/status": { handle: (gw, payload) => gw.mcpOAuthStatus(payload) },
	"mcp/oauth/authorize": { handle: (gw, payload) => gw.mcpOAuthAuthorize(payload) },
	"mcp/oauth/refresh": { handle: (gw, payload) => gw.mcpOAuthRefresh(payload) },
	"mcp/oauth/forget": { handle: (gw, payload) => gw.mcpOAuthForget(payload) },
	// 代理设置：读取是只读的（state 里也带一份）；测试要联网，放宽超时自然由 git 自己管。
	"proxy/get": { handle: (gw) => gw.proxyGet(), readOnly: true },
	"proxy/save": { handle: (gw, payload) => gw.proxySave(payload) },
	"proxy/test": { handle: (gw, payload) => gw.proxyTest(payload) },
	// 配置打包：导出只读；预检与执行都需要放宽体积上限。
	"bundle/export": { handle: (gw, payload) => gw.exportBundle(payload) },
	"bundle/plan": { handle: (gw, payload) => gw.importPlan(payload), bodyLimit: BODY_LIMIT_IMPORT },
	"bundle/import": { handle: (gw, payload) => gw.applyImport(payload), bodyLimit: BODY_LIMIT_IMPORT, skills: true },
	// 插件自身更新：检查与状态只读（检查要联网但无副作用），执行必须 POST。
	"update/check": { handle: (gw) => gw.updateCheck(), readOnly: true },
	"update/status": { handle: (gw) => gw.updateStatus(), readOnly: true },
	"update/apply": { handle: (gw) => gw.updateApply() }
};

/**
 * 挂载全部路由，返回 disposer 列表。
 * @param webServer DSH web server 服务
 * @param gateway   网关实例
 */
export function mountRoutes(webServer, gateway) {
	const disposers = [];
	for (const [suffix, route] of Object.entries(ROUTES)) {
		const path = `${ROUTE_PREFIX}/${suffix}`;
		const { handle, readOnly = false, bodyLimit = BODY_LIMIT_DEFAULT, skills = false } = route;
		disposers.push(
			webServer.register({
				kind: "exact",
				path,
				handler: async (request, response) => {
					try {
						if (request.method === "GET" && readOnly) {
							sendJson(response, 200, await handle(gateway, {}));
							return;
						}
						if (request.method !== "POST") {
							response.writeHead(405, { allow: readOnly ? "GET, POST" : "POST" });
							response.end();
							return;
						}
						if (!isTrustedWrite(request)) {
							sendJson(response, 403, { error: "untrusted origin" });
							return;
						}
						const payload = await readJsonBody(request, bodyLimit);
						const result = await handle(gateway, payload);
						// 改动过技能就失效目录缓存，让 `/` 菜单立刻跟上。
						if (skills) gateway.skillsChanged();
						sendJson(response, 200, result);
					} catch (error) {
						sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			})
		);
	}
	return disposers;
}

/**
 * 插件入口：挂载管理路由，并把本插件管理的技能接进 DSH 的技能注册表。
 * @param ctx    cordis 宿主上下文
 * @param config 插件配置（可选 `dshHome` 覆盖）
 */
export function apply(ctx, config = {}) {
	const gateway = new SkillMcpGateway(ctx, config);

	// 技能注册表提供方。
	//
	// 用 `ctx.inject` 而不是把 "skills" 写进顶层 `inject`：注册表只是本插件的
	// **增强**项，缺了它管理界面照样能用；写成硬依赖会让整个插件在缺服务时
	// 直接不加载，代价太大。
	ctx.inject(["skills"], (skilled) => {
		let provider;
		try {
			provider = registerSkillProvider(skilled, {
				// 走与界面同一套根解析，保证「列表里有什么」和「`/` 里有什么」一致。
				// 不传 cwd 时只含用户级根，避免把宿主进程的工作目录误当成项目根。
				getRoots: async (cwd) => buildRoots(typeof cwd === "string" ? cwd : "", { dshHome: gateway.dshHome }),
				logger: ctx.logger
			});
		} catch (error) {
			// 注册失败只该损失「`/` 里能选技能」这一增强，绝不能让整个插件挂掉。
			ctx.logger?.warn?.(`dsh-skill-mcp-tool: 注册 skill 提供方失败，/ 菜单将不含本插件管理的技能：${String(error)}`);
			return;
		}
		// 插件自己改技能后就地失效缓存：比等 fs 事件更即时、也更确定。
		gateway.onSkillsChanged = () => provider.invalidate();
		skilled.effect(() => () => {
			gateway.onSkillsChanged = undefined;
			provider.dispose();
		}, "dsh-skill-mcp-tool: skill provider");
		ctx.logger?.info(`dsh-skill-mcp-tool: 已注册 skill 提供方 "${SKILL_PROVIDER_NAME}"，/ 菜单可匹配本插件管理的技能`);
	});

	ctx.inject(["webServer"], (host) => {
		host.effect(() => {
			const disposers = mountRoutes(host.webServer, gateway);
			return () => {
				for (const dispose of disposers) {
					try {
						dispose?.();
					} catch {
						// 卸载期忽略。
					}
				}
			};
		}, "dsh-skill-mcp-tool: http routes");
		ctx.logger?.info(`dsh-skill-mcp-tool: 已挂载 ${ROUTE_PREFIX}/*（patch: ${gateway.patchPath}）`);
	});
}

export { SkillMcpGateway };
