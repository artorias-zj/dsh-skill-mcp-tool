/**
 * dsh-skill-mcp-tool —— 客户端半区（浏览器束）。
 *
 * 契约（由宿主 dsh-client-modules 决定，无法绕过）：
 *   - 束是**惰性 CJS**：顶层只调用 `window.__ModuleLoader__.load`，所有副作用
 *     必须写在 `factory(require)` 闭包内；
 *   - `require` 只能解析外壳种子词（react / react-dom / react/jsx-runtime）与
 *     启动图里已物化的模块。**因此不 import 任何宿主 Client 包** —— 官方
 *     插件开发规范明确要求第三方插件自绘控件并只引用 `--dsw-alias-*` 主题变量，
 *     因为宿主 primitives 会无预警变化，且本插件没有类型检查兜底。
 *   - 样式：自带 CSS，类名前缀 `smt-`，注入为 `<style data-plugin>` 标签。
 *
 * 三处入口（主界面左侧栏图标 + 对应主面板，以及设置菜单页）共用同一套页面组件。
 *
 * @module dsh-skill-mcp-tool/client
 */
window.__ModuleLoader__.load({
	id: "dsh-skill-mcp-tool",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 语言命名空间。 */
		const NS = "dsh-skill-mcp-tool";
		/** 侧栏行 id 与主面板 key 必须一致。 */
		const PANEL_ID = "skill-mcp-tool";
		/** 宿主 HTTP 路由前缀。 */
		const API = "/dsh-skill-mcp-tool";

		// ── 字典 ────────────────────────────────────────────────────────────
		const zh = {
			nav: "技能与 MCP",
			panel: "技能与 MCP",
			title: "技能与 MCP 管理",
			tagline: "统一管理 Skills 与 MCP 服务器，启用/停用即时热加载，无需重启",
			refresh: "刷新",
			loading: "加载中…",
			loadFailed: "加载失败",
			retry: "重试",
			tabSkills: "技能",
			tabMcp: "MCP",
			tabSources: "远程来源",
			search: "搜索名称或描述…",
			enabled: "已启用",
			disabled: "已停用",
			invalid: "格式不合规",
			pluginProvided: "插件提供",
			readOnly: "只读",
			enable: "启用",
			disable: "停用",
			edit: "编辑",
			remove: "删除",
			save: "保存",
			cancel: "取消",
			confirmRemoveSkill: "确定删除该技能？此操作会删除磁盘上的文件，无法撤销。",
			confirmRemoveServer: "确定删除该 MCP 服务器行？",
			noSkills: "未发现任何技能",
			noSearchHit: "没有匹配的技能",
			noServers: "尚未配置任何 MCP 服务器",
			externalServers: "配置文件中其他来源的服务器（只读）",
			managedServers: "本插件管理的服务器",
			addServer: "添加服务器",
			addServerTitle: "新增 MCP 服务器",
			editServerTitle: "编辑 MCP 服务器",
			serverName: "服务器名（工具前缀）",
			serverNameHint: "1-32 位字母、数字、下划线或连字符；工具将显示为 mcp__名字__工具",
			transport: "传输方式",
			transportStdio: "stdio（本地进程）",
			transportHttp: "streamable-http（远程服务）",
			command: "命令",
			args: "参数",
			argsHint: "每行一个参数",
			env: "环境变量",
			envHint: "键=值，每行一个；值支持 ${VAR} 读取环境变量",
			cwd: "工作目录",
			url: "服务地址",
			headers: "请求头",
			timeout: "调用超时（毫秒）",
			failOnStartup: "启动失败时拒绝加载",
			reconnect: "断线自动重连",
			reconnectEnabled: "启用重连",
			initialDelay: "首次重连延迟（毫秒）",
			maxDelay: "最大退避延迟（毫秒）",
			maxAttempts: "最大重试次数",
			toolCount: "工具数",
			phase: "状态",
			saved: "已保存",
			hotReloaded: "已热加载",
			reconcilePending: "写入成功，但宿主尚未完成重挂载",
			installSkill: "从 Git 安装",
			installTitle: "从 Git 仓库安装技能",
			repoUrl: "仓库地址",
			repoUrlHint: "支持 owner/repo、https://…、git@host:owner/repo",
			ref: "分支 / 标签 / 提交",
			refHint: "留空为默认分支",
			subPath: "仓库子目录",
			subPathHint: "留空扫描整个仓库",
			targetRoot: "安装到",
			kind: "形式",
			kindBundle: "目录束（<名字>/SKILL.md）",
			kindFlat: "单文件（<名字>.md）",
			install: "安装 / 更新",
			installing: "正在克隆并安装…",
			installedCount: "已安装 {count} 个技能",
			excludedDirs: "已跳过仓库元数据/依赖目录",
			skipped: "跳过 {count} 个不合规项",
			gitMissing: "未检测到 git，无法从仓库安装",
			noSources: "尚未记录任何远程来源",
			sourceUpdatedAt: "更新于",
			sourceCommit: "提交",
			checkUpdates: "检查更新",
			update: "更新",
			forget: "移除记录",
			upToDate: "已是最新",
			outdated: "有更新",
			unknown: "无法确定",
			confirmForget: "仅移除本地记录（不删除已安装的技能文件）？",
			newSkill: "新建技能",
			editSkillTitle: "编辑技能",
			newSkillTitle: "新建技能",
			skillContent: "SKILL.md 内容（含 frontmatter）",
			skillContentHint: "必须以 --- 开头，包含 name 与 description",
			rootLabel: "位置",
			sourceProjectDsh: "项目 .dsh",
			sourceProjectAgents: "项目 .agents",
			sourceUserDsh: "用户 .dsh",
			sourceUserAgents: "user .agents",
			patchFile: "配置文件",
			gitVersion: "git"
		};
		const en = {
			nav: "Skills & MCP",
			panel: "Skills & MCP",
			title: "Skills & MCP manager",
			tagline: "One place to manage Skills and MCP servers — toggles hot-reload with no restart",
			refresh: "Refresh",
			loading: "Loading…",
			loadFailed: "Failed to load",
			retry: "Retry",
			tabSkills: "Skills",
			tabMcp: "MCP",
			tabSources: "Remote sources",
			search: "Search name or description…",
			enabled: "Enabled",
			disabled: "Disabled",
			invalid: "Invalid format",
			pluginProvided: "Plugin-provided",
			readOnly: "read-only",
			enable: "Enable",
			disable: "Disable",
			edit: "Edit",
			remove: "Delete",
			save: "Save",
			cancel: "Cancel",
			confirmRemoveSkill: "Delete this skill? Files on disk are removed and this cannot be undone.",
			confirmRemoveServer: "Delete this MCP server row?",
			noSkills: "No skills found",
			noSearchHit: "No matching skills",
			noServers: "No MCP servers configured",
			externalServers: "Servers declared elsewhere in config (read-only)",
			managedServers: "Servers managed by this plugin",
			addServer: "Add server",
			addServerTitle: "New MCP server",
			editServerTitle: "Edit MCP server",
			serverName: "Server name (tool prefix)",
			serverNameHint: "1-32 chars: letters, digits, underscore, hyphen. Tools appear as mcp__name__tool",
			transport: "Transport",
			transportStdio: "stdio (local process)",
			transportHttp: "streamable-http (remote)",
			command: "Command",
			args: "Arguments",
			argsHint: "One argument per line",
			env: "Environment",
			envHint: "KEY=value per line; values support ${VAR}",
			cwd: "Working directory",
			url: "Endpoint URL",
			headers: "Headers",
			timeout: "Tool-call timeout (ms)",
			failOnStartup: "Reject load on startup failure",
			reconnect: "Reconnect",
			reconnectEnabled: "Enable reconnect",
			initialDelay: "Initial delay (ms)",
			maxDelay: "Max backoff (ms)",
			maxAttempts: "Max attempts",
			toolCount: "Tools",
			phase: "State",
			saved: "Saved",
			hotReloaded: "Hot-reloaded",
			reconcilePending: "Written, but the host has not finished remounting",
			installSkill: "Install from Git",
			installTitle: "Install skills from a Git repository",
			repoUrl: "Repository",
			repoUrlHint: "owner/repo, https://…, or git@host:owner/repo",
			ref: "Branch / tag / commit",
			refHint: "Empty uses the default branch",
			subPath: "Subdirectory",
			subPathHint: "Empty scans the whole repository",
			targetRoot: "Install into",
			kind: "Form",
			kindBundle: "Directory bundle (<name>/SKILL.md)",
			kindFlat: "Flat file (<name>.md)",
			install: "Install / update",
			installing: "Cloning and installing…",
			installedCount: "Installed {count} skill(s)",
			excludedDirs: "Skipped repository metadata / dependency directories",
			skipped: "Skipped {count} invalid item(s)",
			gitMissing: "git was not found — repository install unavailable",
			noSources: "No remote sources recorded yet",
			sourceUpdatedAt: "Updated",
			sourceCommit: "Commit",
			checkUpdates: "Check for updates",
			update: "Update",
			forget: "Forget",
			upToDate: "Up to date",
			outdated: "Update available",
			unknown: "Unknown",
			confirmForget: "Forget this source locally? Installed skill files are kept.",
			newSkill: "New skill",
			editSkillTitle: "Edit skill",
			newSkillTitle: "New skill",
			skillContent: "SKILL.md content (with frontmatter)",
			skillContentHint: "Must start with --- and include name and description",
			rootLabel: "Location",
			sourceProjectDsh: "project .dsh",
			sourceProjectAgents: "project .agents",
			sourceUserDsh: "user .dsh",
			sourceUserAgents: "user .agents",
			patchFile: "Config file",
			gitVersion: "git"
		};

		// ── 样式（类名前缀 smt-，只引用 --dsw-alias-* 主题变量）────────────────
		const css = `
/* 版面壳：两个宿主槽位的排版契约不同，必须分开处理。
 *
 *   - 设置页（settings.section）：宿主把内容渲染在「内容列」里，自带内边距，
 *     通常也自带滚动。所以这里不加内边距、不加高度约束，保持自然流动。
 *   - 主面板（main）：ownerProps 是空数组 —— 宿主既不给内边距，也不给滚动
 *     容器。若不自己撑，内容会贴到左上角，且技能一多就**没有滚动方式**，
 *     超出的部分直接看不到。
 *
 * 主面板因此自己承担整个滚动职责：外壳定高 + 头部/页签固定 + 只有列表滚动。
 * 这样技能再多也能滚，且切页签/刷新始终够得着。
 *
 * 注：外壳用 height:100% 拿到高度（宿主把面板放进定高的中栏，官方会话面板同样
 * 依赖这一点）。万一宿主某天不再给定高度，height:100% 会退化成内容高度，内层
 * 滚动区随之被撑开、滚动落到最近的祖先滚动容器上 —— 无论哪种情况内容都够得着，
 * 不会出现「被裁掉且无法触及」的最坏情况；区别只是头部是否还固定。
 *
 * 用 data-surface 区分，避免设置页被叠加内边距或出现双层滚动条。 */
.smt-shell{width:100%;box-sizing:border-box}
.smt-shell[data-surface=settings]{padding:0}
.smt-shell[data-surface=main]{height:100%;min-height:0;display:flex;flex-direction:column;padding:0}
.smt-shellInner{width:100%;max-width:920px;margin:0 auto;min-width:0;display:flex;flex-direction:column;gap:14px}
.smt-shell[data-surface=main] .smt-shellInner{flex:1;min-height:0;padding:clamp(16px,2.5vw,32px) clamp(20px,4vw,48px) 0}
/* 滚动区：主面板里只有这块滚，头部与页签保持可见。
 *
 * 两件事一起做，都是为了「滚动条不参与版面」：
 *
 * 1. 不预留也不显示滚动条。刻意不用 scrollbar-gutter:stable —— 它在内容不足
 *    一屏时也强行预留宽度（实测 stable 预留 15px、加 both-edges 预留 30px），
 *    会在没得滚的页面上留下一条空槽。
 * 2. 滚动条本身隐藏（见下方规则）。因此横向留白**恒等于**内层的 padding，
 *    无论内容长短、无论是否需要滚动，左右都完全对称，也不会因滚动条出现
 *    或消失而左右跳动。
 *
 * 滚动能力本身不受影响：滚轮、触控板、触摸、键盘方向键/PageUp/PageDown、
 * 拖到边缘都不变，只是不再绘制滚动条。 */
.smt-scroll{display:flex;flex-direction:column;gap:14px;min-width:0}
.smt-shell[data-surface=main] .smt-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding-bottom:clamp(24px,4vw,40px)}
/* 隐藏滚动条但保留滚动（Chromium/Safari 用 ::-webkit-scrollbar，
 * Firefox 用 scrollbar-width，旧 Edge/IE 用 -ms-overflow-style）。
 * 三套都写，避免任一浏览器退化成显示原生滚动条、又把留白挤歪。
 * 同样作用于弹窗；弹窗内长表单（如 MCP 编辑器）同样能滚。
 * 宽度/高度归零 + display:none 已完全移除绘制，无需再写 track/thumb 规则。 */
.smt-scroll,.smt-modal{scrollbar-width:none;-ms-overflow-style:none}
.smt-scroll::-webkit-scrollbar,.smt-modal::-webkit-scrollbar{width:0;height:0;display:none}
.smt-root{display:flex;flex-direction:column;gap:14px;width:100%;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.smt-shell[data-surface=main] .smt-root{flex:1;min-height:0}
.smt-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.smt-headMain{flex:1;min-width:220px}
.smt-title{font-size:16px;font-weight:600;line-height:24px;margin:0}
.smt-tagline{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:2px 0 0}
.smt-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.smt-btn{font:inherit;font-size:13px;line-height:18px;cursor:pointer;border-radius:8px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary)}
.smt-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.smt-btn:disabled{cursor:default;opacity:.55}
.smt-btn[data-variant=primary]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.smt-btn[data-variant=primary]:hover:not(:disabled){filter:brightness(1.08)}
.smt-btn[data-variant=danger]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.smt-btn[data-variant=danger]:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.smt-btn[data-size=sm]{font-size:12px;line-height:16px;padding:3px 9px;border-radius:7px}
.smt-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:0}
.smt-tab{font:inherit;font-size:13px;line-height:20px;cursor:pointer;background:0 0;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);padding:6px 12px;margin-bottom:-1px}
.smt-tab:hover{color:var(--dsw-alias-label-primary)}
.smt-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.smt-search{width:100%;box-sizing:border-box;height:34px;font:inherit;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 12px;outline:0}
.smt-search:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.smt-field{display:flex;flex-direction:column;gap:4px}
.smt-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.smt-input,.smt-textarea,.smt-select{width:100%;box-sizing:border-box;font:inherit;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 10px;outline:0}
.smt-input,.smt-select{height:32px;padding:0 10px}
.smt-textarea{min-height:120px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;resize:vertical}
.smt-input:focus-visible,.smt-textarea:focus-visible,.smt-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.smt-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.smt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:640px){.smt-grid{grid-template-columns:minmax(0,1fr)}}
.smt-list{display:flex;flex-direction:column;gap:8px}
.smt-group{display:flex;flex-direction:column;gap:8px}
.smt-groupHead{display:flex;align-items:baseline;gap:8px;padding:0 2px}
.smt-groupName{font-size:12px;font-weight:600;line-height:18px}
.smt-groupCount{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.smt-card{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.smt-card[data-disabled=true]{opacity:.62}
.smt-cardMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.smt-name{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:13px;font-weight:600;line-height:20px;word-break:break-word}
.smt-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.smt-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.smt-cardActions{display:flex;gap:6px;align-items:center;flex:none;flex-wrap:wrap;justify-content:flex-end}
.smt-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;border-radius:6px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.smt-badge[data-tone=on]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.smt-badge[data-tone=off]{color:var(--dsw-alias-label-tertiary)}
.smt-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent)}
.smt-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.smt-badge[data-tone=info]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.smt-switch{position:relative;display:inline-flex;width:34px;height:20px;flex:none;cursor:pointer}
.smt-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.smt-switchTrack{position:absolute;inset:0;border-radius:10px;background:var(--dsw-alias-border-l2);transition:background .15s}
.smt-switchThumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.smt-switch input:checked~.smt-switchTrack{background:var(--dsw-alias-brand-primary)}
.smt-switch input:checked~.smt-switchThumb{transform:translateX(14px)}
.smt-switch input:disabled~.smt-switchTrack{opacity:.5}
.smt-switch input:focus-visible~.smt-switchTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.smt-notice{display:flex;align-items:center;gap:10px;border-radius:8px;padding:8px 12px;border:1px solid transparent;font-size:12px;line-height:18px}
.smt-notice[data-kind=error]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.smt-notice[data-kind=info]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-brand-primary)}
.smt-notice[data-kind=success]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-state-success-primary)}
.smt-noticeText{flex:1;min-width:0;word-break:break-word}
.smt-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:14px 2px}
.smt-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;z-index:60;padding:20px}
.smt-modal{width:100%;max-width:640px;max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 32px rgba(0,0,0,.28)}
.smt-modalHead{display:flex;align-items:center;gap:10px}
.smt-modalTitle{font-size:14px;font-weight:600;line-height:22px;margin:0;flex:1}
.smt-modalFoot{display:flex;gap:8px;justify-content:flex-end;padding-top:2px}
.smt-sep{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}
.smt-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.smt-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-size:12px;line-height:18px}
.smt-kvKey{color:var(--dsw-alias-label-tertiary)}
.smt-kvVal{color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.smt-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:smt-spin .7s linear infinite;vertical-align:-2px}
@keyframes smt-spin{to{transform:rotate(360deg)}}
.smt-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer}
.smt-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.smt-iconBtn:disabled{opacity:.5;cursor:default}
`;
		/** 注入样式（幂等；HMR 换束时旧标签由模块系统回收）。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = NS;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── HTTP 客户端 ─────────────────────────────────────────────────────
		/**
		 * 调用宿主接口（同源 POST）；失败时把宿主返回的中文错误原样抛出。
		 *
		 * 宿主对只读接口也接受 GET，但这里统一走 POST：一来写接口必须 POST，
		 * 二来单一代码路径省掉「哪些接口是只读」这份需要同步维护的清单。
		 */
		async function apiPost(path, payload) {
			const response = await fetch(`${API}/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload ?? {})
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
			return body;
		}

		/**
		 * 弹窗里的「提交」流程：置忙 → 清错 → 执行 → 成功回调 → 复位。
		 *
		 * 与 `runBusy` 的区别是错误就地显示在弹窗里（`setError`），不弹全局提示 ——
		 * 弹窗打开时上下文就是这次提交，就地把原因放在表单上方更易读。
		 *
		 * @returns task 的返回值；失败时为 undefined
		 */
		async function runForm(setBusy, setError, task, onSuccess) {
			setBusy(true);
			setError(null);
			try {
				const result = await task();
				if (onSuccess) await onSuccess(result);
				return result;
			} catch (error) {
				setError(errText(error));
				return undefined;
			} finally {
				setBusy(false);
			}
		}

		// ── 小工具 ──────────────────────────────────────────────────────────
		/** 异常 → 可展示文案（宿主抛的 Error 带中文原因，直接用它）。 */
		function errText(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/**
		 * 「置忙 → 执行 → 提示 → 复位」——界面上多处重复的同一套流程。
		 *
		 * 各页差异只在三点，用 options 表达：成功后是否重载、成功提示文案
		 * （可以是函数，拿得到接口返回值）、以及忙碌标记的粒度 —— 技能页按名字
		 * 标记（只有那一张卡禁用），MCP/来源页整体标记。
		 *
		 * `success` 返回字符串即按 success 提示；返回 `{ kind, message }` 可自选
		 * 语气（例如宿主尚未完成重挂载时用 info 而不是 success，避免误报已生效）。
		 *
		 * @param setBusy 忙碌态 setter
		 * @param key     忙碌标记值
		 * @param task    实际调用
		 * @param options { notify, reload, success }
		 * @returns task 的返回值；失败时为 undefined
		 */
		async function runBusy(setBusy, key, task, options = {}) {
			const { notify, reload, success } = options;
			setBusy(key);
			try {
				const result = await task();
				if (reload) await reload();
				if (success) {
					const outcome = typeof success === "function" ? success(result) : success;
					if (typeof outcome === "object" && outcome !== null) notify(outcome.kind, outcome.message);
					else notify("success", outcome);
				}
				return result;
			} catch (error) {
				notify("error", errText(error));
				return undefined;
			} finally {
				setBusy(null);
			}
		}

		/** 当前工作目录（项目技能作用域锚点）。取不到时返回 undefined，由宿主回退。 */
		function useCwd() {
			return React.useMemo(() => {
				try {
					const params = new URLSearchParams(window.location.search);
					const fromQuery = params.get("cwd");
					if (typeof fromQuery === "string" && fromQuery !== "") return fromQuery;
				} catch {
					// 忽略：非浏览器环境
				}
				return undefined;
			}, []);
		}

		/**
		 * 名称比较器 —— 「首字母排序」。
		 *
		 * 与宿主半区 `compareName` 同一规则：先按小写串比较，让大小写混排的名字
		 * （`REA` / `chrome-devtools`）落在预期的字母位置；仅当小写相同才用原串
		 * 打破平局。固定 `en` 区域，避免跟随系统区域导致顺序随机器变化。
		 */
		function compareName(a, b) {
			const left = String(a ?? "");
			const right = String(b ?? "");
			const byLower = left.toLowerCase().localeCompare(right.toLowerCase(), "en");
			return byLower !== 0 ? byLower : left.localeCompare(right, "en");
		}

		/** 「键=值」多行文本 ↔ 对象。 */
		function linesToMap(text) {
			const map = {};
			for (const line of String(text ?? "").split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "" || trimmed.startsWith("#")) continue;
				const index = trimmed.indexOf("=");
				if (index < 0) {
					map[trimmed] = "";
					continue;
				}
				map[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
			}
			return map;
		}

		/** 由列表接口数据推导出「服务器表单」初始值。 */
		function serverToForm(server) {
			return {
				serverName: server?.serverName ?? "",
				transport: server?.transport === "streamable-http" ? "streamable-http" : "stdio",
				command: server?.command ?? "",
				argsText: Array.isArray(server?.args) ? server.args.join("\n") : "",
				envText: server?.envKeys?.length ? server.envKeys.map((key) => `${key}=`).join("\n") : "",
				cwd: server?.cwd ?? "",
				url: server?.url ?? "",
				headersText: server?.headerKeys?.length ? server.headerKeys.map((key) => `${key}=`).join("\n") : "",
				timeout: String(server?.toolCallTimeoutMs ?? 60000),
				failOnStartup: server?.failOnStartupError === true,
				reconnectEnabled: server?.reconnect?.enabled !== false,
				initialDelay: String(server?.reconnect?.initialDelayMs ?? 500),
				maxDelay: String(server?.reconnect?.maxDelayMs ?? 30000),
				maxAttempts: String(server?.reconnect?.maxAttempts ?? 10)
			};
		}

		/** 表单 → 提交载荷。空密钥值不发送（表示保留旧值）。 */
		function formToPayload(form, previousName) {
			const env = linesToMap(form.envText);
			const headers = linesToMap(form.headersText);
			const cleaned = (map) => {
				const out = {};
				for (const [key, value] of Object.entries(map)) if (value !== "") out[key] = value;
				return out;
			};
			const common = {
				serverName: form.serverName.trim(),
				transport: form.transport,
				toolCallTimeoutMs: Number(form.timeout) || 60000,
				failOnStartupError: form.failOnStartup,
				reconnect: {
					enabled: form.reconnectEnabled,
					initialDelayMs: Number(form.initialDelay) || 500,
					maxDelayMs: Number(form.maxDelay) || 30000,
					maxAttempts: Number(form.maxAttempts) || 10
				}
			};
			const input =
				form.transport === "stdio"
					? {
							...common,
							command: form.command.trim(),
							args: form.argsText.split("\n").map((line) => line.trim()).filter((line) => line !== ""),
							env: cleaned(env),
							cwd: form.cwd.trim()
						}
					: { ...common, url: form.url.trim(), headers: cleaned(headers) };
			return { input, previousServerName: previousName };
		}

		// ── 通用控件 ────────────────────────────────────────────────────────
		function Notice({ kind, children, onRetry, retryLabel }) {
			return h(
				"div",
				{ className: "smt-notice", "data-kind": kind },
				h("span", { className: "smt-noticeText" }, children),
				onRetry ? h("button", { type: "button", className: "smt-btn", "data-size": "sm", onClick: onRetry }, retryLabel ?? "retry") : null
			);
		}

		function Switch({ checked, disabled, onChange, label }) {
			return h(
				"label",
				{ className: "smt-switch", title: label },
				h("input", {
					type: "checkbox",
					checked: checked,
					disabled: disabled,
					"aria-label": label,
					onChange: (event) => onChange(event.target.checked)
				}),
				h("span", { className: "smt-switchTrack" }),
				h("span", { className: "smt-switchThumb" })
			);
		}

		function Field({ label, hint, children }) {
			return h(
				"label",
				{ className: "smt-field" },
				h("span", { className: "smt-fieldLabel" }, label),
				children,
				hint ? h("span", { className: "smt-hint" }, hint) : null
			);
		}

		function Modal({ title, onClose, children, footer }) {
			React.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			return h(
				"div",
				{ className: "smt-overlay", onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
				h(
					"div",
					{ className: "smt-modal", role: "dialog", "aria-modal": "true", "aria-label": title },
					h(
						"div",
						{ className: "smt-modalHead" },
						h("h3", { className: "smt-modalTitle" }, title),
						h("button", { type: "button", className: "smt-iconBtn", onClick: onClose, "aria-label": "close" }, "✕")
					),
					h("div", { className: "smt-sep" }),
					children,
					footer ? h("div", { className: "smt-modalFoot" }, footer) : null
				)
			);
		}

		// ── 技能编辑器 ──────────────────────────────────────────────────────
		function SkillEditor({ t, roots, initial, onClose, onSaved }) {
			const [content, setContent] = React.useState(initial?.content ?? "---\nname: my-skill\ndescription: \n---\n\n");
			const [rootPath, setRootPath] = React.useState(initial?.rootPath ?? roots.find((r) => r.source === "user-dsh")?.path ?? roots[0]?.path ?? "");
			const [kind, setKind] = React.useState(initial?.kind === "flat" ? "flat" : "bundle");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const cwd = useCwd();

			const save = () =>
				runForm(
					setBusy,
					setError,
					() => apiPost("skill/write", { content, rootPath, kind, previousName: initial?.previousName, cwd }),
					onSaved
				);

			return h(
				Modal,
				{
					title: initial?.previousName ? t("editSkillTitle") : t("newSkillTitle"),
					onClose,
					footer: [
						h("button", { key: "cancel", type: "button", className: "smt-btn", onClick: onClose }, t("cancel")),
						h("button", { key: "save", type: "button", className: "smt-btn", "data-variant": "primary", disabled: busy, onClick: save }, busy ? h("span", { className: "smt-spin" }) : t("save"))
					]
				},
				error ? h(Notice, { kind: "error" }, error) : null,
				h(
					"div",
					{ className: "smt-grid" },
					h(
						Field,
						{ label: t("rootLabel") },
						h(
							"select",
							{ className: "smt-select", value: rootPath, onChange: (event) => setRootPath(event.target.value) },
							roots.map((root) => h("option", { key: root.path, value: root.path }, `${root.path}  (${sourceLabel(t, root.source)})`))
						)
					),
					h(
						Field,
						{ label: t("kind") },
						h(
							"select",
							{ className: "smt-select", value: kind, onChange: (event) => setKind(event.target.value), disabled: Boolean(initial?.previousName) },
							h("option", { value: "bundle" }, t("kindBundle")),
							h("option", { value: "flat" }, t("kindFlat"))
						)
					)
				),
				h(
					Field,
					{ label: t("skillContent"), hint: t("skillContentHint") },
					h("textarea", { className: "smt-textarea", style: { minHeight: 260 }, value: content, onChange: (event) => setContent(event.target.value), spellCheck: false })
				)
			);
		}

		// ── 技能页 ──────────────────────────────────────────────────────────
		function SkillsSection({ t, state, reload, notify }) {
			const [query, setQuery] = React.useState("");
			const [busyName, setBusyName] = React.useState(null);
			const [editor, setEditor] = React.useState(null);
			const [installer, setInstaller] = React.useState(false);
			const cwd = useCwd();
			const skills = state?.skills?.skills ?? [];
			const roots = state?.skills?.roots ?? [];

			const filtered = React.useMemo(() => {
				const needle = query.trim().toLowerCase();
				if (needle === "") return skills;
				return skills.filter(
					(skill) =>
						skill.name.toLowerCase().includes(needle)
						|| String(skill.description ?? "").toLowerCase().includes(needle)
				);
			}, [skills, query]);

			const groups = React.useMemo(() => {
				const bySource = new Map();
				for (const skill of filtered) {
					const key = skill.pluginProvided ? "plugin" : skill.source ?? "custom";
					if (!bySource.has(key)) bySource.set(key, []);
					bySource.get(key).push(skill);
				}
				// 组内按名字首字母排序（宿主已排过，这里再排一次以防旧版宿主）。
				for (const items of bySource.values()) items.sort((a, b) => compareName(a.name, b.name));
				// 组顺序固定：项目 → 用户 → 插件。不按内容变化，避免列表顺序随之跳动。
				return [...bySource.entries()].sort((a, b) => sourceGroupRank(a[0]) - sourceGroupRank(b[0]) || compareName(a[0], b[0]));
			}, [filtered]);

			const toggle = (skill, enabled) =>
				runBusy(setBusyName, skill.name, () => apiPost("skill/set-enabled", { name: skill.name, enabled, cwd }), {
					notify,
					reload,
					success: `${skill.name} · ${enabled ? t("enabled") : t("disabled")}`
				});

			const remove = (skill) => {
				if (!window.confirm(t("confirmRemoveSkill"))) return undefined;
				return runBusy(setBusyName, skill.name, () => apiPost("skill/remove", { name: skill.name, cwd }), {
					notify,
					reload,
					success: `${skill.name} · ${t("remove")}`
				});
			};

			const openEditor = async (skill) => {
				if (skill === null) {
					setEditor({ previousName: undefined, kind: "bundle", content: "---\nname: \ndescription: \n---\n\n" });
					return;
				}
				try {
					const detail = await apiPost("skill/read", { name: skill.name, cwd });
					setEditor({
						previousName: skill.name,
						kind: skill.kind,
						content: detail.content,
						// 编辑时必须回填技能自己所在的根，否则保存会把它挪到别的根。
						rootPath: rootForFile(roots, detail.file)
					});
				} catch (error) {
					notify("error", errText(error));
				}
			};

			return h(
				"div",
				{ className: "smt-root" },
				h(
					"div",
					{ className: "smt-actions" },
					h("input", { className: "smt-search", placeholder: t("search"), value: query, onChange: (event) => setQuery(event.target.value) }),
					h("button", { type: "button", className: "smt-btn", onClick: () => setInstaller(true) }, t("installSkill")),
					h("button", { type: "button", className: "smt-btn", "data-variant": "primary", onClick: () => openEditor(null) }, t("newSkill"))
				),
				state?.skills?.registryError
					? h(Notice, { kind: "error" }, `${t("loadFailed")}: ${state.skills.registryError}`)
					: null,
				filtered.length === 0
					? h("div", { className: "smt-empty" }, skills.length === 0 ? t("noSkills") : t("noSearchHit"))
					: groups.map(([source, items]) =>
							h(
								"div",
								{ key: source, className: "smt-group" },
								h(
									"div",
									{ className: "smt-groupHead" },
									h("span", { className: "smt-groupName" }, sourceLabel(t, source)),
									h("span", { className: "smt-groupCount" }, String(items.length))
								),
								h(
									"div",
									{ className: "smt-list" },
									items.map((skill) =>
										h(
											"div",
											{ key: `${skill.name}:${skill.file ?? source}`, className: "smt-card", "data-disabled": skill.enabled === false },
											h(
												"div",
												{ className: "smt-cardMain" },
												h(
													"div",
													{ className: "smt-name" },
													skill.name,
													skill.enabled === false ? h("span", { className: "smt-badge", "data-tone": "off" }, t("disabled")) : null,
													skill.valid === false ? h("span", { className: "smt-badge", "data-tone": "error" }, t("invalid")) : null,
													skill.pluginProvided ? h("span", { className: "smt-badge", "data-tone": "info" }, t("pluginProvided")) : null,
													skill.modelInvocable === false ? h("span", { className: "smt-badge", "data-tone": "warn" }, "no-model") : null
												),
												skill.description ? h("div", { className: "smt-desc" }, skill.description) : null,
												h("div", { className: "smt-meta" }, skill.file ?? skill.source)
											),
											h(
												"div",
												{ className: "smt-cardActions" },
												skill.toggleable
													? h(Switch, {
															checked: skill.enabled !== false,
															disabled: busyName === skill.name,
															onChange: (next) => toggle(skill, next),
															label: skill.enabled === false ? t("enable") : t("disable")
														})
													: h("span", { className: "smt-badge", "data-tone": "off" }, t("readOnly")),
												skill.toggleable
													? h("button", { type: "button", className: "smt-btn", "data-size": "sm", disabled: busyName === skill.name, onClick: () => openEditor(skill) }, t("edit"))
													: null,
												skill.toggleable
													? h("button", { type: "button", className: "smt-btn", "data-size": "sm", "data-variant": "danger", disabled: busyName === skill.name, onClick: () => remove(skill) }, t("remove"))
													: null
											)
										)
									)
								)
							)
						),
				editor !== null
					? h(SkillEditor, {
							t,
							roots: roots.length > 0 ? roots : [{ path: "", source: "user-dsh" }],
							initial: editor,
							onClose: () => setEditor(null),
							onSaved: async (result) => {
								setEditor(null);
								await reload();
								notify("success", `${result.name} · ${t("saved")}`);
							}
						})
					: null,
				installer ? h(Installer, { t, roots, onClose: () => setInstaller(false), reload, notify }) : null
			);
		}

		/** 从 Git 安装技能的对话框。 */
		function Installer({ t, roots, onClose, reload, notify }) {
			const cwd = useCwd();
			const [form, setForm] = React.useState({
				url: "",
				ref: "",
				subPath: "",
				rootPath: roots.find((r) => r.source === "user-dsh")?.path ?? roots[0]?.path ?? "",
				kind: "bundle"
			});
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [result, setResult] = React.useState(null);
			const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

			const run = () => {
				// 重新提交时先清掉上一次结果，避免加载期间仍显示旧成功条。
				setResult(null);
				return runForm(setBusy, setError, () => apiPost("skill/install", { ...form, cwd }), async (outcome) => {
					setResult(outcome);
					await reload();
					notify("success", `${t("installedCount").replace("{count}", String(outcome.installed.length))}`);
				});
			};

			return h(
				Modal,
				{
					title: t("installTitle"),
					onClose,
					footer: [
						h("button", { key: "c", type: "button", className: "smt-btn", onClick: onClose }, t("cancel")),
						h("button", { key: "i", type: "button", className: "smt-btn", "data-variant": "primary", disabled: busy || form.url.trim() === "", onClick: run }, busy ? t("installing") : t("install"))
					]
				},
				error ? h(Notice, { kind: "error" }, error) : null,
				result
					? h(Notice, { kind: "success" }, `${t("installedCount").replace("{count}", String(result.installed.length))} · ${result.installed.map((i) => i.name).join(", ")}`)
					: null,
				// 如实说明被过滤掉的东西（.git / node_modules 等），
				// 避免用户以为「装完了但仓库元数据去哪了」。
				result?.excluded?.length
					? h(Notice, { kind: "info" }, `${t("excludedDirs")}: ${[...new Set(result.excluded.map((item) => String(item).split("/").pop()))].join(", ")}`)
					: null,
				h(
					Field,
					{ label: t("repoUrl"), hint: t("repoUrlHint") },
					h("input", { className: "smt-input", value: form.url, placeholder: "owner/repo", onChange: (event) => set({ url: event.target.value }), spellCheck: false })
				),
				h(
					"div",
					{ className: "smt-grid" },
					h(Field, { label: t("ref"), hint: t("refHint") }, h("input", { className: "smt-input", value: form.ref, onChange: (event) => set({ ref: event.target.value }), spellCheck: false })),
					h(Field, { label: t("subPath"), hint: t("subPathHint") }, h("input", { className: "smt-input", value: form.subPath, onChange: (event) => set({ subPath: event.target.value }), spellCheck: false }))
				),
				h(
					"div",
					{ className: "smt-grid" },
					h(
						Field,
						{ label: t("targetRoot") },
						h(
							"select",
							{ className: "smt-select", value: form.rootPath, onChange: (event) => set({ rootPath: event.target.value }) },
							roots.map((root) => h("option", { key: root.path, value: root.path }, `${root.path}  (${sourceLabel(t, root.source)})`))
						)
					),
					h(
						Field,
						{ label: t("kind") },
						h(
							"select",
							{ className: "smt-select", value: form.kind, onChange: (event) => set({ kind: event.target.value }) },
							h("option", { value: "bundle" }, t("kindBundle")),
							h("option", { value: "flat" }, t("kindFlat"))
						)
					)
				)
			);
		}

		// ── MCP 页 ──────────────────────────────────────────────────────────
		function McpSection({ t, state, reload, notify }) {
			const [busy, setBusy] = React.useState(null);
			const [editor, setEditor] = React.useState(null);
			const patch = state?.mcp?.patch ?? {};
			// 首字母排序；宿主已排过，这里再排一次以防旧版宿主。
			const servers = React.useMemo(
				() => [...(state?.mcp?.servers ?? [])].sort((a, b) => compareName(a.serverName, b.serverName)),
				[state]
			);
			const external = React.useMemo(
				() => [...(state?.mcp?.externalServers ?? [])].sort((a, b) => compareName(a.serverName, b.serverName)),
				[state]
			);

			const toggle = (server, enabled) =>
				runBusy(setBusy, server.serverName, () => apiPost("mcp/set-enabled", { serverName: server.serverName, enabled }), {
					notify,
					reload,
					// 宿主未完成重挂载时不算成功：用 info 语气并附说明，避免误报「已生效」。
					success: (result) => ({
						kind: result.reconciled ? "success" : "info",
						message: `${server.serverName} · ${enabled ? t("enabled") : t("disabled")}${result.reconciled ? "" : ` · ${t("reconcilePending")}`}`
					})
				});

			const remove = (server) => {
				if (!window.confirm(t("confirmRemoveServer"))) return undefined;
				return runBusy(setBusy, server.serverName, () => apiPost("mcp/remove", { serverName: server.serverName }), {
					notify,
					reload,
					success: `${server.serverName} · ${t("remove")}`
				});
			};

			const renderCard = (server, managed) =>
				h(
					"div",
					{ key: server.serverName, className: "smt-card", "data-disabled": server.enabled === false },
					h(
						"div",
						{ className: "smt-cardMain" },
						h(
							"div",
							{ className: "smt-name" },
							server.serverName,
							h("span", { className: "smt-badge", "data-tone": server.enabled ? "on" : "off" }, server.enabled ? t("enabled") : t("disabled")),
							h("span", { className: "smt-badge" }, server.transport),
							managed && server.enabled && server.toolCount > 0
								? h("span", { className: "smt-badge", "data-tone": "info" }, `${t("toolCount")} ${server.toolCount}`)
								: null,
							managed && server.fiberPhase === "failed" ? h("span", { className: "smt-badge", "data-tone": "error" }, "failed") : null
						),
						h(
							"div",
							{ className: "smt-meta" },
							server.transport === "stdio"
								? `${server.command ?? ""} ${Array.isArray(server.args) ? server.args.join(" ") : ""}`.trim()
								: server.url ?? ""
						),
						server.envKeys?.length ? h("div", { className: "smt-meta" }, `env: ${server.envKeys.join(", ")}`) : null,
						server.headerKeys?.length ? h("div", { className: "smt-meta" }, `headers: ${server.headerKeys.join(", ")}`) : null
					),
					h(
						"div",
						{ className: "smt-cardActions" },
						managed
							? h(Switch, {
									checked: server.enabled !== false,
									disabled: busy === server.serverName,
									onChange: (next) => toggle(server, next),
									label: server.enabled ? t("disable") : t("enable")
								})
							: h("span", { className: "smt-badge", "data-tone": "off" }, t("readOnly")),
						managed
							? h("button", { type: "button", className: "smt-btn", "data-size": "sm", disabled: busy === server.serverName, onClick: () => setEditor({ initial: server }) }, t("edit"))
							: null,
						managed
							? h("button", { type: "button", className: "smt-btn", "data-size": "sm", "data-variant": "danger", disabled: busy === server.serverName, onClick: () => remove(server) }, t("remove"))
							: null
					)
				);

			return h(
				"div",
				{ className: "smt-root" },
				h(
					"div",
					{ className: "smt-actions" },
					h("button", { type: "button", className: "smt-btn", "data-variant": "primary", onClick: () => setEditor({ initial: null }) }, t("addServer"))
				),
				patch.ok === false ? h(Notice, { kind: "error" }, `${t("loadFailed")}: ${patch.error} (${patch.path})`) : null,
				state?.mcp?.duplicates?.length
					? h(Notice, { kind: "error" }, `serverName 重复：${state.mcp.duplicates.join(", ")}`)
					: null,
				h(
					"div",
					{ className: "smt-group" },
					h(
						"div",
						{ className: "smt-groupHead" },
						h("span", { className: "smt-groupName" }, t("managedServers")),
						h("span", { className: "smt-groupCount" }, String(servers.length))
					),
					servers.length === 0
						? h("div", { className: "smt-empty" }, t("noServers"))
						: h("div", { className: "smt-list" }, servers.map((server) => renderCard(server, true)))
				),
				external.length > 0
					? h(
							"div",
							{ className: "smt-group" },
							h(
								"div",
								{ className: "smt-groupHead" },
								h("span", { className: "smt-groupName" }, t("externalServers")),
								h("span", { className: "smt-groupCount" }, String(external.length))
							),
							h("div", { className: "smt-list" }, external.map((server) => renderCard(server, false)))
						)
					: null,
				editor !== null
					? h(ServerEditor, {
							t,
							initial: editor.initial,
							onClose: () => setEditor(null),
							onSaved: async () => {
								setEditor(null);
								await reload();
								notify("success", t("saved"));
							},
							notify
						})
					: null
			);
		}

		/** MCP 服务器编辑表单。 */
		function ServerEditor({ t, initial, onClose, onSaved }) {
			const [form, setForm] = React.useState(() => serverToForm(initial));
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [removedEnv, setRemovedEnv] = React.useState([]);
			const [removedHeaders, setRemovedHeaders] = React.useState([]);
			const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
			const isEdit = initial !== null && initial !== undefined;

			/** 记录被删掉的密钥键，让宿主从旧行里移除。 */
			const trackRemovals = (previousKeys, nextText, setRemoved) => {
				const nextKeys = new Set(Object.keys(linesToMap(nextText)));
				setRemoved(previousKeys.filter((key) => !nextKeys.has(key)));
			};

			const submit = () =>
				runForm(setBusy, setError, () => {
					const payload = formToPayload(form, isEdit ? initial.serverName : undefined);
					payload.envRemoved = removedEnv;
					payload.headerRemoved = removedHeaders;
					return apiPost("mcp/save", payload);
				}, onSaved);

			return h(
				Modal,
				{
					title: isEdit ? t("editServerTitle") : t("addServerTitle"),
					onClose,
					footer: [
						h("button", { key: "c", type: "button", className: "smt-btn", onClick: onClose }, t("cancel")),
						h("button", { key: "s", type: "button", className: "smt-btn", "data-variant": "primary", disabled: busy, onClick: submit }, busy ? h("span", { className: "smt-spin" }) : t("save"))
					]
				},
				error ? h(Notice, { kind: "error" }, error) : null,
				h(
					"div",
					{ className: "smt-grid" },
					h(Field, { label: t("serverName"), hint: t("serverNameHint") }, h("input", { className: "smt-input", value: form.serverName, disabled: isEdit, onChange: (event) => set({ serverName: event.target.value }), spellCheck: false })),
					h(
						Field,
						{ label: t("transport") },
						h(
							"select",
							{ className: "smt-select", value: form.transport, disabled: isEdit, onChange: (event) => set({ transport: event.target.value }) },
							h("option", { value: "stdio" }, t("transportStdio")),
							h("option", { value: "streamable-http" }, t("transportHttp"))
						)
					)
				),
				form.transport === "stdio"
					? h(
							"div",
							{ className: "smt-root" },
							h(
								"div",
								{ className: "smt-grid" },
								h(Field, { label: t("command") }, h("input", { className: "smt-input", value: form.command, placeholder: "npx", onChange: (event) => set({ command: event.target.value }), spellCheck: false })),
								h(Field, { label: t("cwd") }, h("input", { className: "smt-input", value: form.cwd, onChange: (event) => set({ cwd: event.target.value }), spellCheck: false }))
							),
							h(Field, { label: t("args"), hint: t("argsHint") }, h("textarea", { className: "smt-textarea", style: { minHeight: 80 }, value: form.argsText, onChange: (event) => set({ argsText: event.target.value }), spellCheck: false })),
							h(
								Field,
								{ label: t("env"), hint: t("envHint") },
								h("textarea", {
									className: "smt-textarea",
									style: { minHeight: 70 },
									value: form.envText,
									onChange: (event) => {
										set({ envText: event.target.value });
										trackRemovals(initial?.envKeys ?? [], event.target.value, setRemovedEnv);
									},
									spellCheck: false
								})
							)
						)
					: h(
							"div",
							{ className: "smt-root" },
							h(Field, { label: t("url") }, h("input", { className: "smt-input", value: form.url, placeholder: "http://localhost:3000/mcp", onChange: (event) => set({ url: event.target.value }), spellCheck: false })),
							h(
								Field,
								{ label: t("headers"), hint: t("envHint") },
								h("textarea", {
									className: "smt-textarea",
									style: { minHeight: 70 },
									value: form.headersText,
									onChange: (event) => {
										set({ headersText: event.target.value });
										trackRemovals(initial?.headerKeys ?? [], event.target.value, setRemovedHeaders);
									},
									spellCheck: false
								})
							)
						),
				h("div", { className: "smt-sep" }),
				h(
					"div",
					{ className: "smt-grid" },
					h(Field, { label: t("timeout") }, h("input", { className: "smt-input", type: "number", min: 1, value: form.timeout, onChange: (event) => set({ timeout: event.target.value }) })),
					h(
						"label",
						{ className: "smt-inline", style: { alignSelf: "end", paddingBottom: 6 } },
						h(Switch, { checked: form.failOnStartup, onChange: (next) => set({ failOnStartup: next }), label: t("failOnStartup") }),
						h("span", { className: "smt-fieldLabel" }, t("failOnStartup"))
					)
				),
				h(
					"div",
					{ className: "smt-inline" },
					h(Switch, { checked: form.reconnectEnabled, onChange: (next) => set({ reconnectEnabled: next }), label: t("reconnectEnabled") }),
					h("span", { className: "smt-fieldLabel" }, t("reconnectEnabled"))
				),
				form.reconnectEnabled
					? h(
							"div",
							{ className: "smt-grid", style: { gridTemplateColumns: "repeat(3,minmax(0,1fr))" } },
							h(Field, { label: t("initialDelay") }, h("input", { className: "smt-input", type: "number", min: 1, value: form.initialDelay, onChange: (event) => set({ initialDelay: event.target.value }) })),
							h(Field, { label: t("maxDelay") }, h("input", { className: "smt-input", type: "number", min: 1, value: form.maxDelay, onChange: (event) => set({ maxDelay: event.target.value }) })),
							h(Field, { label: t("maxAttempts") }, h("input", { className: "smt-input", type: "number", min: 1, value: form.maxAttempts, onChange: (event) => set({ maxAttempts: event.target.value }) }))
						)
					: null
			);
		}

		// ── 来源页 ──────────────────────────────────────────────────────────
		function SourcesSection({ t, state, reload, notify }) {
			const [busy, setBusy] = React.useState(false);
			const [checks, setChecks] = React.useState({});
			// 首字母排序（按仓库标签）；宿主已排过，这里再排一次以防旧版宿主。
			const sources = React.useMemo(
				() => [...(state?.sources ?? [])].sort((a, b) => compareName(a?.label, b?.label)),
				[state]
			);
			const git = state?.environment?.git ?? null;

			// 只查状态、不重载列表，成功也不弹提示（结果直接体现在每张卡上）。
			const check = async () => {
				const result = await runBusy(setBusy, true, () => apiPost("skill/check-updates", {}), { notify });
				if (result === undefined) return;
				const map = {};
				for (const item of result.results ?? []) map[item.label] = item.status;
				setChecks(map);
			};

			const update = (label) =>
				runBusy(setBusy, true, () => apiPost("skill/update", { label }), {
					notify,
					reload,
					success: (result) => `${label} · ${t("installedCount").replace("{count}", String(result.installed.length))}`
				});

			const forget = (label) => {
				if (!window.confirm(t("confirmForget"))) return undefined;
				return runBusy(setBusy, true, () => apiPost("skill/forget-source", { label }), { notify, reload });
			};

			return h(
				"div",
				{ className: "smt-root" },
				h(
					"div",
					{ className: "smt-actions" },
					h("button", { type: "button", className: "smt-btn", disabled: busy || git === null, onClick: check }, busy ? h("span", { className: "smt-spin" }) : t("checkUpdates"))
				),
				git === null ? h(Notice, { kind: "error" }, t("gitMissing")) : null,
				h(
					"div",
					{ className: "smt-kv" },
					h("span", { className: "smt-kvKey" }, t("patchFile")),
					h("span", { className: "smt-kvVal" }, state?.environment?.patchPath ?? ""),
					h("span", { className: "smt-kvKey" }, t("gitVersion")),
					h("span", { className: "smt-kvVal" }, git ?? "—")
				),
				sources.length === 0
					? h("div", { className: "smt-empty" }, t("noSources"))
					: h(
							"div",
							{ className: "smt-list" },
							sources.map((source) => {
								const status = checks[source.label];
								return h(
									"div",
									{ key: source.label, className: "smt-card" },
									h(
										"div",
										{ className: "smt-cardMain" },
										h(
											"div",
											{ className: "smt-name" },
											source.label,
											status === "outdated" ? h("span", { className: "smt-badge", "data-tone": "warn" }, t("outdated")) : null,
											status === "current" ? h("span", { className: "smt-badge", "data-tone": "on" }, t("upToDate")) : null,
											status === "unknown" ? h("span", { className: "smt-badge" }, t("unknown")) : null
										),
										h("div", { className: "smt-meta" }, source.url),
										h("div", { className: "smt-meta" }, `${source.skills?.join(", ") ?? ""}`),
										h("div", { className: "smt-meta" }, `${t("sourceCommit")} ${String(source.commit ?? "").slice(0, 10)} · ${t("sourceUpdatedAt")} ${source.updatedAt ?? ""}`)
									),
									h(
										"div",
										{ className: "smt-cardActions" },
										h("button", { type: "button", className: "smt-btn", "data-size": "sm", disabled: busy, onClick: () => update(source.label) }, t("update")),
										h("button", { type: "button", className: "smt-btn", "data-size": "sm", "data-variant": "danger", onClick: () => forget(source.label) }, t("forget"))
									)
								);
							})
						)
			);
		}

		/** 由技能文件路径反查它所属的根（用于编辑时回填位置）。 */
		function rootForFile(roots, file) {
			if (typeof file !== "string" || file === "") return undefined;
			const normalized = file.replace(/\\/g, "/").toLowerCase();
			let best;
			for (const root of roots) {
				const rootPath = String(root.path ?? "").replace(/\\/g, "/").toLowerCase();
				if (rootPath === "" || !normalized.startsWith(rootPath)) continue;
				if (best === undefined || rootPath.length > String(best.path).length) best = root;
			}
			return best?.path;
		}

		/**
		 * 技能分组顺序：项目 → 用户 → 插件 → 其他。
		 *
		 * 固定分级而非按内容动态排序，组标题位置就不会随技能增减而跳动；
		 * 同一级内的多个来源再按名称字母序。
		 */
		function sourceGroupRank(source) {
			switch (source) {
				case "project-dsh": return 10;
				case "project-agents": return 20;
				case "user-dsh": return 30;
				case "user-agents": return 40;
				case "plugin": return 50;
				default: return 60;
			}
		}

		/** 根来源标签。 */
		function sourceLabel(t, source) {
			switch (source) {
				case "project-dsh": return t("sourceProjectDsh");
				case "project-agents": return t("sourceProjectAgents");
				case "user-dsh": return t("sourceUserDsh");
				case "user-agents": return t("sourceUserAgents");
				case "plugin": return t("pluginProvided");
				default: return source ?? "custom";
			}
		}

		// ── 主页面（三个入口共用）────────────────────────────────────────────
		/**
		 * 统一面板。
		 *
		 * `surface` 指明宿主槽位，决定外层留白：
		 *   - `"main"`（侧栏图标打开的主面板）：宿主不给内边距，本组件自己撑；
		 *   - `"settings"`（设置菜单页）：宿主已渲染在内容列里，不再加内边距。
		 * 内容列宽度上限（920px）放在共享内层里，两个入口对齐一致。
		 */
		function SkillMcpPanel({ t, surface = "settings" }) {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(true);
			const [tab, setTab] = React.useState("skills");
			const [toast, setToast] = React.useState(null);
			const cwd = useCwd();

			const reload = React.useCallback(async () => {
				setLoading(true);
				try {
					setState(await apiPost("state", { cwd }));
					setError(null);
				} catch (err) {
					setError(errText(err));
				} finally {
					setLoading(false);
				}
			}, [cwd]);

			React.useEffect(() => {
				void reload();
			}, [reload]);

			// 提示条自动消失。
			React.useEffect(() => {
				if (toast === null) return undefined;
				const timer = window.setTimeout(() => setToast(null), 6000);
				return () => window.clearTimeout(timer);
			}, [toast]);

			const notify = React.useCallback((kind, message) => setToast({ kind, message }), []);

			const tabButton = (id, label) =>
				h("button", { key: id, type: "button", className: "smt-tab", "data-active": tab === id, onClick: () => setTab(id) }, label);

			return h(
				"div",
				{ className: "smt-shell", "data-surface": surface },
				h(
					"div",
					{ className: "smt-shellInner" },
					// 固定区：标题、提示、页签。主面板里不参与滚动，
					// 所以技能再多也总能切页签或刷新。
					h(
						"div",
						{ className: "smt-head" },
						h(
							"div",
							{ className: "smt-headMain" },
							h("h2", { className: "smt-title" }, t("title")),
							h("p", { className: "smt-tagline" }, t("tagline"))
						),
						h(
							"div",
							{ className: "smt-actions" },
							loading ? h("span", { className: "smt-spin" }) : null,
							h("button", { type: "button", className: "smt-btn", onClick: () => void reload(), disabled: loading }, t("refresh"))
						)
					),
					toast !== null ? h(Notice, { kind: toast.kind }, toast.message) : null,
					error !== null
						? h(Notice, { kind: "error", onRetry: () => void reload(), retryLabel: t("retry") }, `${t("loadFailed")}: ${error}`)
						: null,
					h(
						"div",
						{ className: "smt-tabs" },
						tabButton("skills", `${t("tabSkills")} (${state?.skills?.skills?.length ?? 0})`),
						tabButton("mcp", `${t("tabMcp")} (${state?.mcp?.servers?.length ?? 0})`),
						tabButton("sources", `${t("tabSources")} (${state?.sources?.length ?? 0})`)
					),
					// 滚动区：主面板里由它承担滚动；设置页里自然展开交给宿主。
					h(
						"div",
						{ className: "smt-scroll" },
						h(
							"div",
							{ className: "smt-root" },
							state === null && loading ? h("div", { className: "smt-empty" }, t("loading")) : null,
							state !== null && tab === "skills" ? h(SkillsSection, { t, state, reload, notify }) : null,
							state !== null && tab === "mcp" ? h(McpSection, { t, state, reload, notify }) : null,
							state !== null && tab === "sources" ? h(SourcesSection, { t, state, reload, notify }) : null
						)
					)
				)
			);
		}

		/** 侧栏图标。 */
		function PanelIcon(props) {
			const size = typeof props?.size === "number" ? props.size : 16;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, focusable: false },
				// 方块 = 技能，连线 = MCP 挂载
				h("rect", { x: 1.5, y: 2.5, width: 5.5, height: 5.5, rx: 1.4, stroke: "currentColor", strokeWidth: 1.3 }),
				h("rect", { x: 9, y: 2.5, width: 5.5, height: 5.5, rx: 1.4, stroke: "currentColor", strokeWidth: 1.3, opacity: 0.55 }),
				h("path", { d: "M2.2 13.2h4.4M9.4 13.2h4.4", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
				h("path", { d: "M4.25 8v2.6M11.75 8v2.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
			);
		}

		// ── cordis 插件体 ───────────────────────────────────────────────────
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ensureStyles();
			// 字典随插件 fiber 注册/注销。
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);
			const t = ctx.locale.bind(NS);

			// ① 设置菜单页。
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: NS,
						order: 55,
						label: () => t("nav"),
						locale: NS
					},
					(props) => h(SkillMcpPanel, { t: props?.t ?? t, surface: "settings" })
				)
			);

			// ② 主界面左侧栏图标行。
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 2,
						label: () => t("panel"),
						locale: NS
					},
					PanelIcon
				)
			);

			// ③ 对应主面板；key 必须与上面的行 id 一致。
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						locale: NS
					},
					(props) => h(SkillMcpPanel, { t: props?.t ?? t, surface: "main" })
				)
			);

			ctx.logger?.info?.(`${NS}: UI registered`);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = NS;
		return module.exports;
	}
});
