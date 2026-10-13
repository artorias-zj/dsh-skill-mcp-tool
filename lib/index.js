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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkSourceUpdate, checkGitAvailable, forgetSource, installFromRepo, loadSources } from "./git-source.js";
import { duplicateServerNames, normalizeServerInput, patchRowToView, serverNameFromRowId, toPatchRow } from "./mcp-model.js";
import { compareName, sortByName } from "./name-order.js";
import { extractManagedRows, listMcpPatchRows, readPatchFile, writeManagedRows } from "./patch-store.js";
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

/** 读取 JSON 请求体（上限 2 MB）。 */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 2 * 1024 * 1024) throw new Error("请求体过大");
		chunks.push(chunk);
	}
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
			const servers = [];
			for (const row of managed) {
				const view = this.decorateMcpRow(row, true, row.disabled !== true);
				if (view !== undefined) servers.push(view);
			}
			const externalServers = [];
			for (const row of external) {
				const view = this.decorateMcpRow(row, false, row.disabled !== true);
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
	 */
	async waitForLoader(id, predicate, timeoutMs = 8000) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const entry = this.loaderEntry(id);
			if (predicate(entry)) return true;
			await new Promise((r) => setTimeout(r, 200));
		}
		return false;
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
			dshHome: this.dshHome
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
			dshHome: this.dshHome
		});
	}

	async skillCheckUpdates() {
		const sources = await loadSources(this.dshHome);
		const results = await Promise.all(
			sources.map(async (source) => ({ label: source.label, ...(await checkSourceUpdate(source)) }))
		);
		results.sort((a, b) => compareName(a.label, b.label));
		return { results, git: await checkGitAvailable() };
	}

	async skillForgetSource(payload) {
		const removed = await forgetSource(this.dshHome, String(payload.label ?? ""));
		return { removed };
	}

	// ── 汇总 ─────────────────────────────────────────────────────────────────

	async state(payload) {
		const cwd = payload.cwd;
		const [skills, mcp, sources, git] = await Promise.all([
			this.listSkills(cwd).catch((error) => ({ skills: [], roots: [], error: error instanceof Error ? error.message : String(error) })),
			this.listMcp(),
			loadSources(this.dshHome)
				.catch(() => [])
				.then((list) => sortByName(list, (source) => source?.label)),
			checkGitAvailable()
		]);
		return {
			skills,
			mcp,
			sources,
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

/** 声明式路由表：path → handler(gateway, payload)。 */
const ROUTES = {
	"state": (gw, payload) => gw.state(payload),
	"skill/set-enabled": (gw, payload) => gw.skillSetEnabled(payload),
	"skill/remove": (gw, payload) => gw.skillRemove(payload),
	"skill/read": (gw, payload) => gw.skillRead(payload),
	"skill/write": (gw, payload) => gw.skillWrite(payload),
	"skill/install": (gw, payload) => gw.skillInstall(payload),
	"skill/update": (gw, payload) => gw.skillUpdate(payload),
	"skill/check-updates": (gw) => gw.skillCheckUpdates(),
	"skill/forget-source": (gw, payload) => gw.skillForgetSource(payload),
	"mcp/save": (gw, payload) => gw.mcpSave(payload),
	"mcp/remove": (gw, payload) => gw.mcpRemove(payload),
	"mcp/set-enabled": (gw, payload) => gw.mcpSetEnabled(payload),
	"mcp/list": (gw) => gw.listMcp()
};

/**
 * 挂载全部路由，返回 disposer 列表。
 * @param webServer DSH web server 服务
 * @param gateway   网关实例
 */
export function mountRoutes(webServer, gateway) {
	const disposers = [];
	for (const [suffix, handler] of Object.entries(ROUTES)) {
		const path = `${ROUTE_PREFIX}/${suffix}`;
		// GET 只用于只读接口；其余一律要求同源 POST。
		const readOnly = suffix === "state" || suffix === "mcp/list";
		disposers.push(
			webServer.register({
				kind: "exact",
				path,
				handler: async (request, response) => {
					try {
						if (request.method === "GET" && readOnly) {
							sendJson(response, 200, await handler(gateway, {}));
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
						const payload = await readJsonBody(request);
						sendJson(response, 200, await handler(gateway, payload));
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
 * 插件入口：等 web server 就绪后挂载管理路由。
 * @param ctx    cordis 宿主上下文
 * @param config 插件配置（可选 `dshHome` 覆盖）
 */
export function apply(ctx, config = {}) {
	const gateway = new SkillMcpGateway(ctx, config);
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
