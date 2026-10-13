/**
 * dsh-skill-mcp-tool —— 从 Git 仓库获取 / 更新 skills。
 *
 * 流程：浅克隆到临时目录 → 在克隆树里发现技能（目录束 `SKILL.md` 与平铺 `*.md`）
 * → 校验 frontmatter → 拷贝进目标技能根 → 清理临时目录。
 *
 * 「更新」= 重新克隆同一仓库/引用并覆盖落盘内容，因此远端改动一次拉取即可生效；
 * 技能文件的变化会被官方 skill 提供方的 watcher 感知，无需重启 DSH。
 *
 * 安装记录写在 `<DSH_HOME>/skill-mcp-tool/sources.json`，用于列出「已安装来源」并
 * 支持再次更新。记录只是索引：即使记录丢失，技能文件本身仍然正常工作。
 *
 * 安全约束：
 *   - 落盘路径必须位于已知技能根之内（防目录穿越）；
 *   - `GIT_TERMINAL_PROMPT=0`，私有仓库缺凭据时快速失败而不是挂起等待输入；
 *   - 单次 git 调用有超时与输出上限。
 *
 * @module dsh-skill-mcp-tool/git-source
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { compareName } from "./name-order.js";
import { parseFrontmatter, pathExists, validateFrontmatter } from "./skill-store.js";

const execFileAsync = promisify(execFile);

/** git 调用超时（毫秒）。 */
const GIT_TIMEOUT_MS = 120000;
/** git 输出上限（字节）。 */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** 克隆树内发现技能的最大深度。 */
const MAX_DISCOVERY_DEPTH = 6;

/**
 * 落盘时要跳过的目录/文件名。
 *
 * 关键的一条是 `.git`：当仓库根**就是**技能包（根目录直接放 `SKILL.md`）时，
 * 克隆出来的树里带着 `.git`，整目录复制会把它一起搬到技能根 —— 用户的
 * `guizang-ppt-skill` 就这样多出 5.5 MB 仓库元数据。`.git` 对技能加载毫无用处
 * （提供方不会读），纯粹是体积与隐私问题（里面含完整提交历史与远端地址）。
 *
 * 其余几项同理：都是「对运行技能无用、但可能很大的东西」。
 * 用 Set 判定，保证每个目录项只查一次。
 *
 * 导出为公共常量：打包（bundle.js）走同一份列表，避免两处各写一份而漂移。
 */
export const COPY_EXCLUDES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".DS_Store",
	"Thumbs.db"
]);

/**
 * 递归复制目录，跳过 COPY_EXCLUDES 里的项。
 *
 * 不用 `cp({ recursive: true, filter })`：Node 的 filter 在部分版本上对
 * 递归复制的目录树行为不一致（跳过目录时其子项仍可能被访问或反过来整棵漏掉），
 * 自己走一遍既确定又能顺手统计跳过了什么。
 *
 * 单独导出是为了能直接验证过滤行为 —— `installFromRepo` 需要真实 git 与网络，
 * 而这里的取舍（什么该复制、什么该丢）正是最容易出错的部分。
 *
 * @returns {{files: number, skipped: string[]}} 复制了多少文件、跳过了哪些顶层项
 */
export async function copyTreeFiltered(source, destination) {
	const skipped = [];
	let files = 0;

	const walk = async (from, to) => {
		await mkdir(to, { recursive: true });
		let entries;
		try {
			entries = await readdir(from, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (COPY_EXCLUDES.has(entry.name)) {
				// 只记顶层被跳过的项，避免深层噪音刷屏。
				if (from === source) skipped.push(entry.name);
				continue;
			}
			const src = join(from, entry.name);
			const dst = join(to, entry.name);
			if (entry.isDirectory()) {
				await walk(src, dst);
			} else if (entry.isFile()) {
				await cp(src, dst, { force: true });
				files++;
			}
			// 符号链接等其它类型一律跳过：技能目录不需要它们，跟着复制反而危险。
		}
	};

	await walk(source, destination);
	return { files, skipped };
}

/** 运行一次 git。失败时抛出带 stderr 摘要的错误。 */
async function runGit(args, options = {}) {
	try {
		return await execFileAsync("git", args, {
			cwd: options.cwd,
			timeout: options.timeout ?? GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" }
		});
	} catch (error) {
		const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
		const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
		const detail = stderr || stdout || (error instanceof Error ? error.message : String(error));
		throw new Error(`git ${args[0]} 失败：${detail.split("\n").slice(-4).join(" ")}`);
	}
}

/** 校验 git 是否可用。 */
export async function checkGitAvailable() {
	try {
		const { stdout } = await runGit(["--version"], { timeout: 10000 });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

/**
 * 归一化仓库地址。
 * 支持 `owner/repo`、`https://host/owner/repo[.git]`、`git@host:owner/repo.git`。
 * @returns 可用于 `git clone` 的 https 地址。
 */
export function normalizeRepoUrl(input) {
	const raw = String(input ?? "").trim();
	if (raw === "") throw new Error("仓库地址不能为空");
	// scp 形式 git@github.com:owner/repo.git
	const scp = /^[A-Za-z0-9_.-]+@([^:]+):(.+)$/.exec(raw);
	if (scp !== null && !raw.includes("://")) {
		return `https://${scp[1]}/${scp[2].replace(/\.git$/, "")}`;
	}
	if (/^https?:\/\//i.test(raw)) return raw.replace(/\.git$/, "").replace(/\/+$/, "");
	// owner/repo 简写
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return `https://github.com/${raw}`;
	throw new Error(`无法识别的仓库地址："${raw}"（支持 owner/repo、https://…、git@host:owner/repo）`);
}

/** 由仓库地址推导一个稳定的短标识（用于记录与展示）。 */
export function repoLabel(url) {
	const cleaned = url.replace(/\.git$/, "").replace(/\/+$/, "");
	const parts = cleaned.split("/").filter(Boolean);
	return parts.slice(-2).join("/") || cleaned;
}

/** 浅克隆到一个临时目录，返回目录路径。 */
async function cloneToTemp(url, ref) {
	const tempRoot = await mkdtemp(join(tmpdir(), "dsh-smt-git-"));
	const target = join(tempRoot, "repo");
	const args = ["clone", "--depth", "1", "--no-tags"];
	if (typeof ref === "string" && ref.trim() !== "") args.push("--branch", ref.trim());
	args.push(url, target);
	try {
		await runGit(args);
	} catch (error) {
		// `--branch` 不接受裸 commit SHA：回退到默认分支克隆后再 checkout。
		if (typeof ref === "string" && ref.trim() !== "") {
			try {
				await runGit(["clone", "--depth", "1", "--no-tags", url, target]);
				await runGit(["checkout", "--detach", ref.trim()], { cwd: target });
			} catch {
				await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
				throw error;
			}
		} else {
			await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
	}
	return { tempRoot, repoDir: target };
}

/** 读取一个技能文件的 frontmatter 校验结果与摘要。 */
async function inspectSkillFile(file) {
	const raw = await readFile(file, "utf8").catch(() => "");
	const strict = validateFrontmatter(raw);
	const loose = parseFrontmatter(raw);
	return {
		valid: strict.ok,
		error: strict.ok ? undefined : strict.error,
		name: strict.ok ? strict.name : loose?.name ?? basename(dirname(file)),
		description: strict.ok ? strict.description : loose?.description ?? ""
	};
}

/**
 * 在克隆树中递归发现技能。
 * 含 `SKILL.md` 的目录视为一个技能包，不再下钻。
 * @returns {{items: Array<{kind,name,dir?,file?,valid,error?,description}>, skipped: number}}
 */
async function discoverSkills(rootDir, subPath) {
	const startDir = typeof subPath === "string" && subPath.trim() !== "" ? resolve(rootDir, subPath.trim()) : resolve(rootDir);
	const relStart = relative(resolve(rootDir), startDir);
	if (relStart.startsWith("..") || isAbsolute(relStart)) throw new Error(`子路径越界："${subPath}"`);
	if (!(await pathExists(startDir))) throw new Error(`仓库中不存在子路径："${subPath}"`);
	const items = [];
	let skipped = 0;

	const walk = async (dir, depth) => {
		if (depth > MAX_DISCOVERY_DEPTH) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// 目录自身含 SKILL.md → 一个技能包，收集后不下钻。
		const ownSkill = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
		if (ownSkill !== undefined) {
			const file = join(dir, "SKILL.md");
			const info = await inspectSkillFile(file);
			if (info.valid) {
				// 包名用 frontmatter 的 name；落盘目录也用它，保持路径与技能名一致。
				items.push({ kind: "bundle", name: info.name, dir, description: info.description, valid: true });
			} else {
				skipped++;
			}
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
				const info = await inspectSkillFile(full);
				if (info.valid) {
					items.push({ kind: "flat", name: info.name, file: full, description: info.description, valid: true });
				} else {
					skipped++;
				}
			}
		}
	};

	await walk(startDir, 0);
	return { items, skipped };
}

/** 确认目标路径位于某个已知技能根之内。 */
function assertInsideRoots(target, roots) {
	const normalized = resolve(target);
	const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
	for (const root of roots) {
		const rootPath = resolve(root.path);
		const rootKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
		if (key === rootKey || key.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep)) return root;
	}
	throw new Error(`目标路径不在已知技能根内，已拒绝写入：${normalized}`);
}

/** 安装来源记录文件路径。 */
function sourcesFile(dshHome) {
	return join(dshHome, "skill-mcp-tool", "sources.json");
}

/** 读取安装来源记录（缺失/损坏返回空表）。 */
export async function loadSources(dshHome) {
	try {
		const raw = await readFile(sourcesFile(dshHome), "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed?.sources) ? parsed.sources : [];
	} catch {
		return [];
	}
}

/** 写入安装来源记录。导出以便导入流程合并记录后落盘。 */
export async function saveSources(dshHome, sources) {
	const file = sourcesFile(dshHome);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`, "utf8");
}

/**
 * 执行一次「安装 / 更新」。
 *
 * @param options.url      仓库地址（必需）
 * @param options.ref      分支 / 标签 / commit（可选）
 * @param options.subPath  仓库内子目录（可选；用于只取某个技能或某组技能）
 * @param options.rootPath 目标技能根（必须在 roots 之内）
 * @param options.kind     `bundle` | `flat` —— 仓库里同名技能未指定时的落盘形态
 * @param options.roots    已知技能根列表（安全边界）
 * @param options.dshHome  DSH 主目录（记录文件位置）
 */
export async function installFromRepo(options) {
	const url = normalizeRepoUrl(options.url);
	const ref = typeof options.ref === "string" ? options.ref.trim() : "";
	const subPath = typeof options.subPath === "string" ? options.subPath.trim() : "";
	const targetRoot = { path: resolve(options.rootPath) };
	assertInsideRoots(targetRoot.path, options.roots);
	await mkdir(targetRoot.path, { recursive: true });

	const { tempRoot, repoDir } = await cloneToTemp(url, ref);
	const written = [];
	const failed = [];
	const excluded = [];
	let commit = "";
	try {
		commit = (await runGit(["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
		const { items, skipped } = await discoverSkills(repoDir, subPath);
		if (items.length === 0) {
			throw new Error(
				skipped > 0
					? `在仓库中发现 ${skipped} 个候选项，但 frontmatter 均不合规（需要 name 与 description）`
					: "仓库中未发现技能（需要 <name>/SKILL.md 目录束或 <name>.md 文件）"
			);
		}
		for (const item of items) {
			const destination =
				item.kind === "bundle" ? join(targetRoot.path, item.name) : join(targetRoot.path, `${item.name}.md`);
			assertInsideRoots(destination, options.roots);
			try {
				// 覆盖式安装：先清掉同名旧内容，避免残留过期文件。
				await rm(destination, { recursive: true, force: true });
				if (item.kind === "bundle") {
					// 过滤复制：跳过 .git / node_modules 等对技能无用的大目录。
					// 仓库根恰好是技能包时，克隆产生的 .git 就在这里，必须挡住。
					const copied = await copyTreeFiltered(item.dir, destination);
					excluded.push(...copied.skipped.map((name) => `${item.name}/${name}`));
				} else {
					await cp(item.file, destination, { force: true });
				}
				// 附带移除可能存在的 .disabled 孪生项，避免同一技能出现启用/停用两份。
				await rm(`${destination}.disabled`, { recursive: true, force: true }).catch(() => {});
				written.push({ name: item.name, path: destination, kind: item.kind, description: item.description });
			} catch (error) {
				failed.push({ name: item.name, error: error instanceof Error ? error.message : String(error) });
			}
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
	}

	// 记录来源，供后续「更新」使用。
	const sources = await loadSources(options.dshHome);
	written.sort((a, b) => compareName(a.name, b.name));
	const label = `${repoLabel(url)}${subPath === "" ? "" : `:${subPath}`}`;
	const existing = sources.findIndex((entry) => entry.label === label);
	const record = {
		label,
		url,
		ref,
		subPath,
		rootPath: targetRoot.path,
		skills: written.map((item) => item.name),
		commit,
		updatedAt: new Date().toISOString(),
		...(existing >= 0 ? { installedAt: sources[existing].installedAt ?? new Date().toISOString() } : { installedAt: new Date().toISOString() })
	};
	if (existing >= 0) sources[existing] = record;
	else sources.push(record);
	// 来源按标签首字母排序，让来源页的「检查更新」结果与列表顺序一致。
	sources.sort((a, b) => compareName(a?.label, b?.label));
	await saveSources(options.dshHome, sources);

	return {
		label,
		url,
		ref,
		commit,
		installed: written,
		failed,
		// 被过滤掉的大目录/元数据（顶层项名，便于界面如实说明省下了什么）。
		excluded,
		rootPath: targetRoot.path,
		updateAvailable: false
	};
}

/** 移除一个安装来源的记录（不删除技能文件）。 */
export async function forgetSource(dshHome, label) {
	const sources = await loadSources(dshHome);
	const next = sources.filter((entry) => entry.label !== label);
	await saveSources(dshHome, next);
	return next.length !== sources.length;
}

/**
 * 检查远端是否有更新：`git ls-remote` 取引用头，与记录的 commit 比较。
 * 网络不可达时返回 `unknown` 而不是抛错 —— 状态展示不应因离线而失败。
 */
export async function checkSourceUpdate(source) {
	try {
		const { stdout } = await runGit(["ls-remote", source.url, source.ref || "HEAD"], { timeout: 30000 });
		const first = stdout.trim().split("\n")[0] ?? "";
		const head = first.split(/\s+/)[0] ?? "";
		if (head === "") return { status: "unknown", head: undefined };
		const current = typeof source.commit === "string" ? source.commit : "";
		if (current === "") return { status: "unknown", head };
		return { status: current === head ? "current" : "outdated", head };
	} catch (error) {
		return { status: "unknown", head: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}
