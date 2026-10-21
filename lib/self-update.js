/**
 * dsh-skill-mcp-tool —— 插件自身的更新检查与一键更新。
 *
 * 两件事分开做，因为它们的安全性完全不同：
 *
 *   1. **检查**：只读。用 `git ls-remote` 拿远端标签与分支，和本机已装版本
 *      / 锁文件里记录的提交比较。不需要网络之外的任何权限。
 *
 *   2. **更新**：真正的写入。这里刻意**不走** DSH 的 `pluginManager`，原因是
 *      自引用：`installBundle` 对已安装的同一 spec 会拒绝（`already-installed`），
 *      官方更新流程因此是 `removeBundle` + `installBundle`。但那段代码跑在
 *      本插件自己的 fiber 里 —— 一旦 `removeBundle` 生效，reload 会把正在执行
 *      这次调用的自身拆掉：HTTP 响应可能永远发不出去，而且一旦随后的安装失败，
 *      插件就处于「已删未装」的状态，用户得手工救回来。
 *
 *      所以更新改为**脱离进程的子进程**执行 `pnpm add <原 spec>`：
 *        · 不卸载任何东西，失败时旧版本继续运行（最坏情况是没更新成功）；
 *        · 不动 `cordis.patch.yml`，不改 bundle 选择；
 *        · 只重解析这个 git 依赖，写回 package.json / 锁文件 / node_modules。
 *
 *      代价是必须重启 DSH 才能加载新代码 —— 但这是本来就要付的：宿主半区
 *      是 ESM 按 URL 缓存的，客户端束也被浏览器按 URL 缓存。所以界面如实说
 *      「已更新，重启 DSH 生效」，而不是假装热更新成功。
 *
 * @module dsh-skill-mcp-tool/self-update
 */
import { spawn } from "node:child_process";
import { open, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listRemoteRefs, normalizeRepoUrl } from "./git-source.js";
import { pathExists } from "./skill-store.js";

/** 更新状态文件与日志的位置（与 sources.json 同目录）。 */
function updateStatePath(dshHome) {
	return join(dshHome, "skill-mcp-tool", "update.json");
}

function updateLogPath(dshHome) {
	return join(dshHome, "skill-mcp-tool", "update.log");
}

/** 检查结果里日志尾部保留的行数。 */
const LOG_TAIL_LINES = 40;

// ── 版本比较 ─────────────────────────────────────────────────────────────────

/**
 * SemVer 解析（只关心比较，不构造）。
 * @returns `{ major, minor, patch, pre }`，`pre` 为预发布标识串（无则 null）
 */
function parseVersion(text) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? "").trim());
	if (match === null) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		pre: match[4] ?? null
	};
}

/**
 * 比较两个预发布标识串。
 *
 * SemVer 的顺序：无预发布 > 有预发布；逐段比较，纯数字段按数值、其余按字典序，
 * 数字段排在字母段之前。够用即可 —— 这里只用来判断「远端是否更新」。
 */
function comparePrerelease(left, right) {
	if (left === null && right === null) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	const a = left.split(".");
	const b = right.split(".");
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const x = a[index];
		const y = b[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
		if (numeric) {
			const diff = Number(x) - Number(y);
			if (diff !== 0) return diff < 0 ? -1 : 1;
			continue;
		}
		if (x === y) continue;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * 比较两个版本号。
 * @returns 负数 / 0 / 正数；任一无法解析时返回 undefined（调用方据此放弃按版本判断）
 */
export function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (a === undefined || b === undefined) return undefined;
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	return comparePrerelease(a.pre, b.pre);
}

// ── 上游地址 ─────────────────────────────────────────────────────────────────

/** 从 package.json 的 `repository` 字段取出可用的 https 地址。 */
export function repoUrlOf(manifest) {
	const raw = typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url;
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	const cleaned = raw.trim().replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
	return /^https?:\/\//i.test(cleaned) ? cleaned : undefined;
}

/**
 * 从 profile 里记录的依赖 spec 推出上游地址。
 * 支持 `github:owner/repo[#ref]`、`git+https://…`、`https://…`。
 */
export function repoUrlFromSpec(spec) {
	if (typeof spec !== "string") return undefined;
	const trimmed = spec.trim().replace(/#.*$/, "");
	if (trimmed.startsWith("github:")) {
		const rest = trimmed.slice("github:".length).replace(/\.git$/, "");
		return rest.includes("/") ? `https://github.com/${rest}` : undefined;
	}
	if (/^(?:git\+)?https?:\/\//i.test(trimmed)) return normalizeRepoUrl(trimmed.replace(/^git\+/, ""));
	return undefined;
}

// ── 本机状态 ─────────────────────────────────────────────────────────────────

/** 读出 profile 的 package.json 里记录的依赖 spec。 */
async function profileDependency(profileDir, name) {
	try {
		const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		const spec = manifest?.dependencies?.[name];
		return typeof spec === "string" ? spec : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从 `pnpm-lock.yaml` 读取这个依赖实际安装到的 git 提交。
 *
 * 锁文件里 git 依赖长这样：
 *     dsh-skill-mcp-tool@https://codeload.github.com/owner/repo/tar.gz/<sha>
 * 因此按「包名@…tar.gz/<40 位十六进制>」定位，避免误取到别的 git 依赖
 * （本 profile 里就有第二个 github 依赖）。
 */
async function installedCommit(profileDir, name) {
	let text;
	try {
		text = await readFile(join(profileDir, "pnpm-lock.yaml"), "utf8");
	} catch {
		return undefined;
	}
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const pattern = new RegExp(`(?:^|\\n)\\s*'?${escaped}@[^\\n]*?/(?:tar\\.gz|tarball)/([0-9a-f]{40})`, "u");
	const match = pattern.exec(text);
	return match?.[1];
}

/** 进程是否还活着（用于判断一次更新是否已经结束）。 */
function isPidAlive(pid) {
	if (typeof pid !== "number" || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM：进程存在但无权探测 —— 仍算活着。
		return error?.code === "EPERM";
	}
}

// ── 检查更新 ─────────────────────────────────────────────────────────────────

/**
 * 检查是否有新版本。
 *
 * 判定优先级：
 *   1. 远端最高 semver 标签 > 已装版本 → `version`（正常的「有新版本」）
 *   2. 版本相同但远端默认分支已走到别的提交 → `commit`（有新提交但还没打标签）
 *   3. 否则 → `none`
 *
 * 本地目录安装（`file:` / `link:`）不联网，直接回 `dev`。
 *
 * @returns 检查结果；网络或 git 失败时抛错，由路由层转成 400 文案
 */
export async function checkPluginUpdate(options) {
	const { name, version, repositoryUrl, profileDir, proxy } = options;
	const spec = await profileDependency(profileDir, name);

	if (typeof spec === "string" && /^(?:file|link):/u.test(spec)) {
		return {
			kind: "dev",
			hasUpdate: false,
			spec,
			installed: { version, commit: await installedCommit(profileDir, name) },
			remote: null,
			checkedAt: new Date().toISOString()
		};
	}

	const url = repositoryUrl ?? repoUrlFromSpec(spec);
	if (url === undefined) {
		throw new Error("无法确定本插件的上游仓库地址：package.json 里没有可用的 repository.url");
	}

	const { heads, tags } = await listRemoteRefs(url, proxy);

	// 远端可用的最高版本标签。
	let latest;
	for (const tag of tags) {
		const parsed = parseVersion(tag.name);
		if (parsed === undefined) continue;
		if (latest === undefined || compareVersions(tag.name, latest.tag) > 0) {
			latest = { tag: tag.name, sha: tag.sha };
		}
	}

	// 默认分支的提交：优先 git 报告的 HEAD，其次常见默认分支名。
	const remoteHead =
		heads.find((item) => item.name === "HEAD") ??
		heads.find((item) => item.name === "main") ??
		heads.find((item) => item.name === "master") ??
		heads[0];

	const commit = await installedCommit(profileDir, name);

	let kind = "none";
	if (latest !== undefined && (compareVersions(latest.tag, version) ?? 0) > 0) {
		kind = "version";
	} else if (remoteHead !== undefined && commit !== undefined && remoteHead.sha !== commit) {
		kind = "commit";
	}

	return {
		kind,
		hasUpdate: kind !== "none",
		spec: spec ?? null,
		installed: { version, commit: commit ?? null },
		remote: {
			url,
			version: latest === undefined ? null : latest.tag.replace(/^v/u, ""),
			tag: latest?.tag ?? null,
			commit: remoteHead?.sha ?? null
		},
		checkedAt: new Date().toISOString()
	};
}

// ── 执行更新 ─────────────────────────────────────────────────────────────────

/**
 * 找到 DSH 自带的 pnpm 与 node。
 *
 * 桌面端的宿主进程跑在 Electron 里，`process.execPath` 不是 node，直接用它会
 * 起不来 pnpm；路径上也没有 `pnpm` 命令。所以按 `dsh-runtimes/<runtime>/dependencies`
 * 去找配对的 node + pnpm.cjs，成对使用。
 *
 * 刻意**不**回退到 `shell: true` 调用 PATH 上的 pnpm：那会把参数拼进命令行，
 * 而 spec 来自 profile 的 package.json，不该被当成 shell 片段解释。
 * 找不到运行时宁可明确报错，让用户知道要换手动更新。
 *
 * @returns `{ command, args }`，可直接交给 spawn（无需 shell）
 */
export async function resolvePackageManager(options) {
	const runtimesDir = join(options.dshHome, "dsh-runtimes");
	let entries = [];
	try {
		entries = await readdir(runtimesDir, { withFileTypes: true });
	} catch {
		entries = [];
	}
	const nodeName = process.platform === "win32" ? "node.exe" : "node";
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const base = join(runtimesDir, entry.name, "dependencies");
		const pnpmScript = join(base, "pnpm", "bin", "pnpm.cjs");
		if (!(await pathExists(pnpmScript))) continue;
		const node = join(base, "node", "bin", nodeName);
		if (await pathExists(node)) return { command: node, args: [pnpmScript] };
	}
	throw new Error(`找不到 DSH 自带的 pnpm（应位于 ${join(runtimesDir, "<runtime>", "dependencies", "pnpm", "bin", "pnpm.cjs")}），请改用 dsh plugin add 手动更新`);
}

/** 子进程环境：把本插件配置的代理转成 npm/pnpm 认得的变量。 */
function childEnv(proxy) {
	const env = { ...process.env };
	const url = typeof proxy === "string" ? proxy.trim() : "";
	if (url !== "") {
		env.npm_config_proxy = url;
		env.npm_config_https_proxy = url;
		env.HTTP_PROXY = url;
		env.HTTPS_PROXY = url;
	} else {
		delete env.npm_config_proxy;
		delete env.npm_config_https_proxy;
	}
	// pnpm 在需要重建 node_modules 时会交互确认；子进程没有 stdin，必须关掉。
	env.npm_config_yes = "true";
	return env;
}

/** 读磁盘上实际装好的版本（更新结束后用来判断是否需要重启）。 */
async function installedVersionOnDisk(profileDir, name) {
	try {
		const manifest = JSON.parse(await readFile(join(profileDir, "node_modules", name, "package.json"), "utf8"));
		return typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		return null;
	}
}

/** 读取更新状态；`running` 但进程已消失时如实标记为未知结果。 */
export async function readUpdateState(dshHome) {
	let state;
	try {
		state = JSON.parse(await readFile(updateStatePath(dshHome), "utf8"));
	} catch {
		return { phase: "idle" };
	}
	if (state?.phase === "running" && !isPidAlive(state.pid)) {
		return { ...state, phase: "unknown" };
	}
	return state;
}

/** 更新日志的尾部若干行，回给界面用于排查。 */
export async function readUpdateLog(dshHome) {
	try {
		const text = await readFile(updateLogPath(dshHome), "utf8");
		const lines = text.split("\n");
		return lines.slice(Math.max(0, lines.length - LOG_TAIL_LINES)).join("\n").trim();
	} catch {
		return "";
	}
}

/**
 * 启动一次后台更新。
 *
 * 立即返回（不等待 pnpm 结束）：pnpm 装一个 git 依赖通常要几十秒，而界面需要
 * 马上拿到「已开始」以便轮询。真正的结果写进状态文件，由 `update/status` 读取。
 *
 * @returns `{ started, state, command }`
 */
export async function startPluginUpdate(options) {
	const { name, profileDir, dshHome, proxy } = options;

	const spec = await profileDependency(profileDir, name);
	if (typeof spec !== "string" || spec.trim() === "") {
		throw new Error("profile 的 package.json 里没有记录本插件的安装来源，无法自动更新；请用 dsh plugin add 手动安装");
	}
	if (/^(?:file|link):/u.test(spec)) {
		throw new Error("本插件是从本地目录安装的（开发模式），不支持一键更新");
	}

	const current = await readUpdateState(dshHome);
	if (current?.phase === "running") {
		throw new Error("已经有一次更新正在进行，请等待它结束");
	}

	const manager = await resolvePackageManager({ dshHome });
	const logPath = updateLogPath(dshHome);
	await mkdir(dirname(logPath), { recursive: true });
	const logHandle = await open(logPath, "w");

	let child;
	try {
		child = spawn(
			manager.command,
			[...manager.args, "add", spec, "--reporter=append-only", "--no-color", "--config.confirmModulesPurge=false"],
			{
				cwd: profileDir,
				env: childEnv(proxy),
				stdio: ["ignore", logHandle.fd, logHandle.fd],
				detached: true,
				windowsHide: true
			}
		);
	} finally {
		// 子进程已经继承了这个句柄，父进程这一份可以关掉。
		await logHandle.close().catch(() => {});
	}

	const startedAt = new Date().toISOString();
	const running = {
		phase: "running",
		pid: child.pid ?? null,
		startedAt,
		finishedAt: null,
		exitCode: null,
		spec,
		logPath,
		from: options.version ?? null,
		to: null
	};
	await writeFile(updateStatePath(dshHome), `${JSON.stringify(running, null, 1)}\n`, "utf8").catch(() => {});

	const finish = async (exitCode) => {
		// 装完后从磁盘读一次真实版本：pnpm 的退出码只说明命令跑完了，
		// 而「到底装上了哪个版本」要读 node_modules 里的 manifest 才算数。
		// 有了它，界面才能区分「已装好、等你重启」和「重启后已经生效」。
		const to = exitCode === 0 ? await installedVersionOnDisk(profileDir, name) : null;
		const done = {
			...running,
			phase: exitCode === 0 ? "done" : "failed",
			exitCode,
			finishedAt: new Date().toISOString(),
			to,
			// 只有「装上的版本 ≠ 正在运行的版本」才需要重启。
			// 相等说明这次更新其实没换版本（例如远端就是这个提交），
			// 此时提示重启只会让用户白重启一次。
			restartRequired: to !== null && to !== (options.version ?? null)
		};
		await writeFile(updateStatePath(dshHome), `${JSON.stringify(done, null, 1)}\n`, "utf8").catch(() => {});
	};
	child.on("error", () => void finish(-1));
	child.on("exit", (code) => void finish(code ?? -1));
	// 让 DSH 退出时不会因为等这个子进程而挂住；子进程自身继续跑完。
	child.unref();

	return { started: true, state: running, command: `${manager.command} add ${spec}` };
}
