/**
 * dsh-skill-mcp-tool —— 内置 skill 提供方。
 *
 * 把本插件管理的技能注册进 DSH 的 `skills` 注册表，使它们在会话内输入 `/`
 * 时能被匹配（该菜单由 `dsh-client-ui-skill` 从 `skills/list` 取
 * 「所有 user-invocable 技能」）；模型侧的 `skill` 工具也就同样能加载它们。
 *
 * 为什么要自己提供一份：
 *   宿主层的 `@deepseek-ai/dsh-skill-filesystem` 行被 web 端**刻意禁用**
 *   （其注释写明 "presets own local discovery"），改由每个 agent 预设自己挂。
 *   实测在本机使用的 `cordis` 预设下该提供方**整体没有生效** —— 连预设自己
 *   声明的 `customSkillDirs` 技能都加载不到，用户目录下的技能自然也不在注册表
 *   里。本模块不依赖预设置是否正确，直接把自己管理的根注册进去。
 *
 * 语义与官方本地提供方对齐（界面里看到什么，`/` 里就是什么）：
 *   - 四个根的 rank 与官方一致：project `.dsh`(100) → project `.agents`(200)
 *     → user `.dsh`(400) → user `.agents`(500)；
 *   - 只报**启用中**且 frontmatter 合规的技能：停用即改名 `.disabled`，这里直接
 *     跳过，于是界面上关掉它，它就从 `/` 消失；
 *   - `disable-model-invocation` / `user-invocable` 映射为调用策略，前者为真即
 *     「仅用户可调用」—— 正是只能从 `/` 进入的那一类；
 *   - 正文每次 `get()` 重读文件，磁盘上的修改立刻反映到下一次加载。
 *
 * 与官方的一处**有意差异**：官方对非法布尔拼写会整条丢弃，本模块沿用
 * `parseFrontmatter` 的宽容取值（回退默认）。理由是「界面显示启用」与
 * 「`/` 里能看到」必须一致，否则会出现「列表里有、菜单里没有」的困惑。
 *
 * 注册表按**技能名**合并、同层内 rank 小者胜，因此即便日后官方提供方恢复
 * 正常，两边重合也不会重复列出。
 *
 * @module dsh-skill-mcp-tool/skill-provider
 */
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { collectSkillEntries, parseFrontmatter } from "./skill-store.js";

/** 注册到 `ctx.skills` 的提供方名（`runtime` 是注册表保留名）。 */
export const SKILL_PROVIDER_NAME = "skill-mcp-tool";

/** 与注册表一致的技能名约束；不满足的条目会被注册表整组丢弃。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 变更事件合并窗口（毫秒）：一次安装会触发大量 fs 事件。 */
const DEBOUNCE_MS = 250;
/** 尚不存在的根的重试间隔（毫秒）——目录可能稍后才被创建。 */
const PROBE_INTERVAL_MS = 15000;

/**
 * 注册提供方。
 *
 * @param ctx 宿主上下文（调用方需已确认能取到 `skills` 服务）
 * @param options.getRoots `async (cwd?) => roots`，返回本插件管理的技能根
 * @param options.logger   可选日志器
 * @returns `{ invalidate, dispose }`。`invalidate` 供插件自身改动技能后主动
 *          失效缓存（比等 fs 事件更即时）；`dispose` 释放 watcher 与定时器。
 */
export function registerSkillProvider(ctx, options) {
	const logger = options.logger;
	/** 每个作用域会各调一次 provider 工厂，控制句柄因此可能不止一个。 */
	const controls = new Set();
	const watcher = createRootWatcher(() => {
		for (const control of controls) {
			try {
				control.invalidate();
			} catch (error) {
				logger?.warn?.(`dsh-skill-mcp-tool: 失效 skill 缓存失败：${String(error)}`);
			}
		}
	});

	ctx.skills.registerProvider((control) => {
		controls.add(control);
		control.signal?.addEventListener("abort", () => controls.delete(control), { once: true });
		return {
			name: SKILL_PROVIDER_NAME,
			/** 发现候选（摘要）。正文留到 `get()` 再读，避免每次列目录都读全部文件。 */
			async list(listOptions = {}) {
				const roots = await options.getRoots(listOptions?.cwd);
				// 顺带把 watcher 对齐到当前根：list() 会在失效后重跑，
				// 于是新出现的项目根也会被监视到。
				watcher.ensure(roots.map((root) => root.path));
				return await collectCandidates(roots, logger);
			},
			/** 按候选 locator 重读正文；文件消失或不再合规时返回 undefined。 */
			async get(candidate, lookup = {}) {
				const locator = candidate?.locator;
				if (locator === null || typeof locator !== "object" || typeof locator.file !== "string") return undefined;
				if (lookup?.signal?.aborted === true) return undefined;
				let raw;
				try {
					raw = await readFile(locator.file, "utf8");
				} catch {
					return undefined; // 文件已消失：由调用方把该条从目录中移除。
				}
				const parsed = parseFrontmatter(raw);
				if (parsed === undefined) return undefined;
				if (!SKILL_NAME.test(parsed.name ?? "") || (parsed.description ?? "") === "") return undefined;
				return {
					name: parsed.name,
					description: parsed.description,
					...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
					invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
					source: locator.source,
					provider: SKILL_PROVIDER_NAME,
					content: parsed.body,
					path: locator.file,
					resourceBase: { kind: "directory", path: locator.dir }
				};
			}
		};
	});

	return {
		/** 主动失效：插件自己增删改技能后调用，`/` 立刻能看到变化。 */
		invalidate() {
			for (const control of controls) {
				try {
					control.invalidate();
				} catch {
					/* 失效失败不影响其它订阅者。 */
				}
			}
		},
		dispose() {
			watcher.dispose();
			controls.clear();
		}
	};
}

/**
 * 收集候选：逐根扫描，同名只保留 rank 最小者（与界面「胜出条目」一致），
 * 再按名字排序，保证菜单顺序稳定。
 */
export async function collectCandidates(roots, logger) {
	const perRoot = await Promise.all(
		roots.map(async (root) => {
			try {
				const entries = await collectSkillEntries([root]);
				return entries.map((entry) => ({ entry, root }));
			} catch (error) {
				logger?.warn?.(`dsh-skill-mcp-tool: 扫描技能根失败 ${root.path}：${String(error)}`);
				return [];
			}
		})
	);

	const winners = new Map();
	for (const { entry, root } of perRoot.flat()) {
		// 停用的技能不进 `/`：界面上「关闭」就该从菜单里消失。
		if (entry.enabled !== true) continue;
		// 注册表对候选是**抛错式**校验，一条坏的会连累整组；这里先自行过滤。
		if (entry.valid !== true) continue;
		if (!SKILL_NAME.test(entry.name) || entry.description === "") continue;
		const current = winners.get(entry.name);
		if (current === undefined || root.rank < current.root.rank) winners.set(entry.name, { entry, root });
	}

	return [...winners.values()]
		.sort((a, b) => (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0))
		.map(({ entry, root }) => ({
			name: entry.name,
			description: entry.description,
			...(entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {}),
			invocation: { modelInvocable: entry.modelInvocable, userInvocable: entry.userInvocable },
			source: entry.source,
			provider: SKILL_PROVIDER_NAME,
			rank: root.rank,
			path: entry.file,
			locator: {
				file: entry.file,
				// 目录束是技能目录本身，平铺就是所在根 —— 两种情况下 dirname 都对。
				dir: dirname(entry.file),
				kind: entry.kind,
				source: entry.source
			}
		}));
}

/**
 * 根目录监视器：任一技能根有增删改就合并成一次通知。
 *
 * 用 `node:fs.watch` 的 recursive 模式（Windows 支持；官方提供方同样依赖
 * recursive 监视）。根尚不存在时建不了 watcher，用低频探针重试 —— 否则
 * 「先打开面板、后安装技能」这条路径永远不会刷新。
 *
 * 只增不减：根集合按会话 cwd 变化，撤掉别的会话用过的 watcher 没有收益，
 * 数量也被实际用到的项目根数目封顶。
 */
function createRootWatcher(onChange) {
	/** path -> FSWatcher */
	const watched = new Map();
	/** 还没建成的根，交给探针重试。 */
	const missing = new Set();
	let probeTimer;
	let debounceTimer;
	let disposed = false;

	function schedule() {
		if (disposed) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			if (!disposed) onChange();
		}, DEBOUNCE_MS);
	}

	function tryAttach(path) {
		if (disposed || watched.has(path)) return;
		try {
			watched.set(path, watch(path, { recursive: true }, () => schedule()));
		} catch {
			/* 目录不存在或不可监视：留给探针重试。 */
		}
	}

	/** 登记并尝试建成这些根的 watcher；全部建成后停掉探针。 */
	function ensure(paths) {
		if (disposed) return;
		for (const path of paths) missing.add(path);
		for (const path of [...missing]) {
			tryAttach(path);
			if (watched.has(path)) missing.delete(path);
		}
		if (missing.size > 0) startProbe();
		else stopProbe();
	}

	function startProbe() {
		if (disposed || probeTimer !== undefined) return;
		probeTimer = setInterval(() => {
			if (disposed) return;
			for (const path of [...missing]) {
				tryAttach(path);
				if (watched.has(path)) missing.delete(path);
			}
			if (missing.size === 0) stopProbe();
		}, PROBE_INTERVAL_MS);
	}

	function stopProbe() {
		clearInterval(probeTimer);
		probeTimer = undefined;
	}

	function dispose() {
		disposed = true;
		clearTimeout(debounceTimer);
		stopProbe();
		for (const watcher of watched.values()) {
			try {
				watcher.close();
			} catch {
				/* 已关闭：忽略。 */
			}
		}
		watched.clear();
		missing.clear();
	}

	return { ensure, dispose };
}
