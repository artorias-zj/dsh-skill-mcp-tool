# dsh-skill-mcp-tool

[![已收录于 DSH Plugin Hub](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/zh/plugins/artorias-zj/dsh-skill-mcp-tool)
[![version](https://img.shields.io/github/v/tag/artorias-zj/dsh-skill-mcp-tool?label=version&color=2ea44f)](https://github.com/artorias-zj/dsh-skill-mcp-tool/releases)
[![license](https://img.shields.io/github/license/artorias-zj/dsh-skill-mcp-tool?color=2ea44f)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.15%20%7C%7C%20%3E%3D24-2ea44f)](package.json)

[English](README.md) | 中文

一个 DeepSeek Harness (DSH) 插件：把 **Skills 与 MCP 服务器统一到一个面板**，设置菜单与主界面左侧栏都有入口，支持**热加载启用/停用**与**从 Git 获取/更新 skills**。

## 功能

**两个入口，一个面板**

- 设置菜单 → 「技能与 MCP」页。
- 主界面 → 左侧栏图标行，在中央主区打开同一个面板。

两处渲染的是同一个组件，四个页签（技能 / MCP / 远程来源 / 备份）行为完全一致。

**面板里能检查并一键更新插件自身**

页签上方（代理条之下）有一条版本行：显示当前运行的版本，按需检查上游仓库，有新版本时给出一键更新。

- **检查**：把已装版本、以及 `pnpm-lock.yaml` 里记录的提交，与 `package.json` 声明的上游仓库的 `git ls-remote` 结果对比，走与技能安装相同的代理。结果分四种：有新版本、版本相同但默认分支有新提交、已是最新、本地目录安装（不检查）。
- **更新**：在**独立子进程**里执行 `pnpm add <你 profile 里已记录的那个 spec>`，**不卸载**插件。失败了旧版本照常运行；成功了重启 DSH 才会加载新代码。
- **不占住请求**：面板轮询状态文件，所以一次几十秒的安装不会把页面卡住，关掉面板也不影响结果。

> **为什么不做热替换？** 宿主半区是 ESM 按 URL 缓存的，客户端束也被浏览器按 URL 缓存 —— 原地替换本来就要重启才能生效。界面如实说明这一点，而不是假装已经更新成功。

**版面：两个入口分开处理**

主面板与设置页的宿主排版契约不同，所以外壳按 `data-surface` 分两套：

- **主面板（侧栏图标打开）**：宿主既不给内边距、也不给滚动容器，所以插件自己负责 ——
  内容居中留白（左右最多 48px，窄窗口自适应收窄），并自己承担滚动。
- **设置页**：宿主已把内容渲染在内容列里（自带内边距与滚动），插件不再叠加，
  否则会出现双层留白和双滚动条。

**滚动：技能再多也翻得到，但看不见滚动条**

主面板里只有列表区滚动，**标题与页签固定在顶部** —— 所以翻到列表底部时，
刷新按钮和页签始终够得着；滚到底部还留有一段呼吸留白。

**滚动条完全不可见**：滚轮、触控板、触摸、键盘（方向键 / PageUp / PageDown）
照常能滚，只是不再绘制滚动条。因此横向留白**恒等于**内层的 padding ——
无论内容长短、无论是否需要滚动，左右都完全对称，也不会因滚动条出现或消失
而左右跳动。同一套规则也作用于弹窗（长表单一样能滚）。

刻意没有用 `scrollbar-gutter: stable` —— 它在内容不足一屏时也会强行预留
滚动条宽度（实测 `stable` 预留 15px、`stable both-edges` 预留 30px），
会在没得滚的页面上留下一条空槽。隐藏滚动条所需的 `scrollbar-width`、
`-ms-overflow-style`、`::-webkit-scrollbar` 三套属性都写了，避免任一浏览器
退化成显示原生滚动条、又把留白挤歪。

**排序：一律按首字母**

列表顺序是**可预期**的，不需要在一堆条目里找：

- **技能**：先按来源分组，组顺序固定为 **项目 → 用户 → 插件 → 其他**（不随内容增减而变化，组标题不会跳动）；**组内按名字首字母排序**。
- **MCP 服务器**：受管行与外部行各自按服务器名首字母排序。
- **远程来源**：按仓库标签首字母排序。
- 排序**大小写不敏感**：`Chrome_DevTools_MCP` 排在 `REA` 前面，而不是大写字母全都挤到最前。仅当两个名字小写完全相同才按原串打破平局（保证顺序稳定）。
- 写入 `cordis.patch.yml` 时受管行也会按同样规则落盘，所以文件内容与界面顺序始终一致。
- 排序在所有写入路径的唯一收口处执行，新增/编辑/启用/停用/删除都不会漏排。

**技能（Skills）**

- 列出四个标准根目录下的全部技能，按官方 rank 顺序：项目 `.dsh/skills`(100) → 项目 `.agents/skills`(200) → 用户 `~/.dsh/skills`(400) → 用户 `~/.agents/skills`(500)。
- 兼容两种布局：目录束（`<name>/SKILL.md`）与平铺单文件（`<name>.md`），并支持嵌套分类目录。
- **启用/停用是无损改名**：`SKILL.md` ⇄ `SKILL.md.disabled`（或 `<name>.md` ⇄ `<name>.md.disabled`）。官方提供方只认精确的文件名，所以技能会从目录中消失，而文件与 `references/`、`scripts/`、`assets/` 完整保留。提供方的 watcher 会在下一次目录刷新时感知 —— **无需重启**。
- 不合规的技能仍然列出，但标记「格式不合规」，让你可以修复或删除，而不是根本看不到它。
- 插件注册的技能（磁盘上无文件）以只读方式列出。
- 内置编辑器可新建、编辑、删除技能；落盘前先校验 frontmatter。
- **从 Git 安装 / 更新**：浅克隆仓库（或其子目录），发现其中全部合规技能，拷贝到指定根目录。会记录来源以便再次拉取更新；`git ls-remote` 判断是否有新版本。
- **落盘时过滤无用目录**：`.git`、`.hg`、`.svn`、`node_modules`、`__pycache__`、`.venv` 等不会进入技能目录。当仓库根**就是**技能包时（根目录直接放 `SKILL.md`），克隆产生的 `.git` 本会被整目录复制进去 —— 实测能省下数 MB 的提交历史与远端地址。界面会如实列出跳过了哪些。
- **在会话里输入 `/` 就能选到技能**：本插件会把管理的技能注册进 DSH 的技能注册表，`/` 菜单因此可以直接匹配并调用它们。`disable-model-invocation: true` 的技能只会出现在这里（模型侧看不到），界面里显示为「停用」的技能不会出现在 `/` 中。改动技能后菜单即时更新，无需重启。

  > 为什么要自己提供一份：宿主层的 `@deepseek-ai/dsh-skill-filesystem` 被 web 端刻意禁用（其注释写明 “presets own local discovery”），改由每个 agent 预设自行挂载。实测在部分预设下该提供方并未生效 —— 磁盘上的技能既不在 `/` 里，模型也加载不到。本插件不依赖预设是否正常，直接注册自己管理的根。

**代理：四个页签上方的 Git 代理设置**

不少网络环境下直连 `git clone` 会超时，导致技能根本装不上、也更新不了。插件在**四个页签上方**放了一条常驻的代理设置 —— 它是四个页签里**所有 Git 操作**（安装、更新、检查更新）的共同前置条件，不属于任何一个页签。

- **命令级注入，绝不改全局配置**：代理以 `git -c http.proxy=… -c https.proxy=… <子命令>` 的形式传入。**你的全局 git 配置一个字节都不会被改写** —— 设置前后各执行一次 `git config --global --get http.proxy` 对比即可确认。插件只给自己的调用加参数。
- **关闭 = 「别管」，不是「清空」**：开关关闭时一个 `-c` 参数都不加，于是 git 沿用你自己配置的路径（直连，或你自己 `git config` 开的代理）。`git p-on` 这类全局设置照常有效。
- **一个「测试」按钮回答「是网络问题还是仓库问题」**：它会同时探两次远端 —— 一次走代理、一次直连 —— 两个结果一起给出，哪条路断了看一眼就知道。本机压根没装 git 时，安装弹窗会单独提示。
- **代理地址里的凭据按密钥对待**：`http://user:pass@host:port` 里的口令回给浏览器时一律脱敏成 `http://user:***@host:port`，导出配置时**默认不写明文**（除非你勾选「包含 MCP 密钥」）。输入框显示的就是脱敏串；原样保存、或只改主机/端口，**已存口令都会被保留**而不会被清掉。若配置包里带着 `***` 而本机没有对应口令，预检会明确提示，而不是落一个空口令、到后面才报一个难以排查的错。
- **支持的协议**：`http`、`https`、`socks4`、`socks4a`、`socks5`、`socks5h`。地址为空或格式不对会带可读原因拒绝，而不是悄悄把代理关掉。
- 导入配置时会**先应用代理、再开始克隆**，所以带着代理的配置包正好能救活一台还没有可用直连线路的新电脑。

**MCP 服务器**

- 增删改查与启用/停用 `@deepseek-ai/dsh-mcp-client` 行，并以只读方式展示配置文件中其他来源声明的服务器。
- 显示每个服务器的实时状态：启用/停用、重连阶段、当前注册的工具数量。
- 密钥处理：API 令牌与请求头**从不回传给浏览器**，只返回键名。编辑时会保留你没有重新输入的键，并允许显式删除某个键。
- 在环境变量或请求头里写 `${MY_TOKEN}`，会被落盘成真正的 `!!js` 表达式（`` `Bearer ${process.env.MY_TOKEN}` ``）—— DSH 没有 `${VAR}` 插值，这是唯一真正读取环境变量的机制。`!!js` 标签在每次编辑中都能逐字节原样往返。

**备份：导出 / 导入配置（换电脑用）**

「备份」页把本插件管理过的 **Skills + MCP 服务器 + Git 来源记录**打包成一个 JSON 文件，在新电脑上导入即可恢复工作环境。

技能有两种载荷，导出时选：

| 模式 | 内容 | 体积 | 导入时 |
|---|---|---|---|
| **配方**（默认） | 只记来源：仓库 + 提交 + 落盘形态 | 通常几 KB | 按记录重新克隆，**需要联网** |
| **完整内容** | 连技能文件一起打包（图片等二进制走 base64） | 可能数 MB | 直接还原文件，**无需联网** |

- **无法回溯来源的技能无论哪种模式都会带内容** —— 否则换电脑后它就丢了，这一点不交给界面决定。
- **导入前先预检**：列出每个条目的动作（新建 / 覆盖）、冲突、需重填的密钥、以及被阻挡的条目。预检不写任何东西，确认后才执行。
- **密钥默认不导出**。插件的常态是密钥从不回传浏览器；导出会打破这条边界，所以必须显式勾选，勾选后界面给出明文警告。未勾选时只写键名，导入后提示你补值。
- 导入是**幂等**的：重复导入同一份配置只会覆盖，不会产生重复条目。
- 上游仓库若已变动，导入后会如实报告「拿到的提交与导出时不同」。

## 安装

```bash
# 从 GitHub 安装（推荐，任何 profile 都能用）
dsh plugin --profile web add github:artorias-zj/dsh-skill-mcp-tool

# desktop profile 用完整地址也可以
dsh plugin --profile desktop add https://github.com/artorias-zj/dsh-skill-mcp-tool
```

也可以在 DSH 侧栏的插件页里指向本目录安装。之后**重启 DSH**，客户端束才会被提供。

> **需要重启。** 插件的客户端 JavaScript 以 URL 寻址并被浏览器/模块系统缓存。启用插件后宿主半区会立即挂载，设置页与侧栏入口在重启后出现。

## 热加载是怎么工作的

DSH **没有运行时增删/重启 MCP 连接的 API**。一个服务器就是一行 loader 条目，受支持的改法是改配置、让 HMR 重挂载该行。本插件写入 profile 的 `cordis.patch.yml`（DSH 的 HMR 监视它），随后轮询 loader 确认该行确实重新挂载。

- **MCP 启用/停用**：设置行上的 `disabled` 布尔值 → HMR 就地卸载或挂载连接。
- **MCP 新增/编辑**：重写该行 → HMR 换上新连接，期间工具名保持稳定。
- **技能启用/停用**：改名文件 → 提供方 watcher 使目录失效。

面板如实报告结果：当写入成功但宿主尚未完成重挂载时，会明确说明，而不是假装成功。

## 配置隔离

MCP 行写在专属受管块内：

```yaml
# >>> dsh-skill-mcp-tool:mcp:begin
- insert:
    - id: smt-mcp-<serverName>
      name: "@deepseek-ai/dsh-mcp-client"
      config: { ... }
# <<< dsh-skill-mcp-tool:mcp:end
```

标记之外的**每一个字节都原样保留**，因此其他插件的受管块（例如 `dsh-skill-mcp-panel`）和你手写的行都不会被碰到。其他工具拥有的行会以只读的「外部服务器」呈现。写入时持有 `<file>.smt.lock` 文件锁并使用临时文件原子改名，并发写入不会破坏文件。

## 插件配置

`cordis.patch.yml` 中该行可选 `config`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 用于定位技能根、profile patch 与来源记录的 DSH 主目录 |

## 会改动的文件

| 路径 | 用途 |
|---|---|
| `<profile>/cordis.patch.yml` | MCP 服务器行，位于受管块内 |
| `<dshHome>/skills/**` | 安装、新建、编辑或切换的技能 |
| `<dshHome>/skill-mcp-tool/sources.json` | Git 安装来源索引（仅为索引 —— 删除它不影响已安装技能） |
| `<dshHome>/skill-mcp-tool/settings.json` | 插件设置 —— 目前只有 Git 代理。刻意不写进 `cordis.patch.yml`：本插件只拥有自己 MCP 标记之间的字节 |
| `<dshHome>/skill-mcp-tool/update.json` | 上一次自更新的进度（阶段、退出码、更新前后版本）。由子进程写入，因此重启后界面仍能读到结果 |
| `<dshHome>/skill-mcp-tool/update.log` | 上一次 `pnpm add` 的输出，失败时在面板里展示 |

## HTTP 路由

全部同源；写操作仅接受 POST，并做来源校验以拒绝跨站请求。

| 路由 | 用途 |
|---|---|
| `state` | 一次读取技能 + MCP + 来源 + 代理 + 环境信息 |
| `skill/set-enabled`、`skill/remove`、`skill/read`、`skill/write` | 技能管理 |
| `skill/install`、`skill/update`、`skill/check-updates`、`skill/forget-source` | Git 来源 |
| `mcp/list`、`mcp/save`、`mcp/remove`、`mcp/set-enabled` | MCP 管理 |
| `proxy/get`、`proxy/save`、`proxy/test` | Git 代理：读取 / 保存 / 双路径探针 |
| `bundle/export`、`bundle/plan`、`bundle/import` | 配置导出 / 预检 / 导入 |
| `update/check`、`update/status`、`update/apply` | 自更新：对比上游 / 轮询进度 / 开始更新 |

## 插件信息

| 字段 | 值 |
|---|---|
| 一句话价值 | 统一管理 Skills 与 MCP，热加载开关 + 从 Git 安装/更新技能 |
| 分类 | Skills & MCP |
| 支持 profile | desktop / web |
| 兼容性 | DeepSeek Harness 0.2.x；Node.js ^22.15 或 >=24；Windows / macOS / Linux |
| 权限与服务 | 读写 profile 的 `cordis.patch.yml` 与本地技能根；安装/更新时调用 `git`（可选走你配置的代理）；无遥测 |
| 许可证 | MIT |

## 许可证

MIT
