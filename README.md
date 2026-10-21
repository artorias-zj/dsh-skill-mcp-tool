# dsh-skill-mcp-tool

[![Listed on DSH Plugin Hub](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/artorias-zj/dsh-skill-mcp-tool)
[![version](https://img.shields.io/github/v/tag/artorias-zj/dsh-skill-mcp-tool?label=version&color=2ea44f)](https://github.com/artorias-zj/dsh-skill-mcp-tool/releases)
[![license](https://img.shields.io/github/license/artorias-zj/dsh-skill-mcp-tool?color=2ea44f)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.15%20%7C%7C%20%3E%3D24-2ea44f)](package.json)

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that puts **Skills and MCP servers under one roof**, reachable from both the settings menu and a main-interface sidebar entry — with **hot-reload enable/disable toggles** and **Git-based skill install/update**.

## Features

**Two entry points, one panel**

- Settings menu → "技能与 MCP" / "Skills & MCP" page.
- Main interface → a sidebar icon row that opens the same panel in the centre column.

Both render the identical component, so the four tabs (Skills / MCP / Remote sources / Backup) behave the same wherever you open them.

**The plugin updates itself from the panel**

A version row sits above the tab strip (below the proxy bar): it shows the running version, checks the upstream repository on demand, and offers a one-click update when a newer tag — or newer commits on the default branch — exist.

- **Check** compares the installed version and the commit recorded in `pnpm-lock.yaml` against `git ls-remote` of the repository declared in `package.json`, using the same proxy as skill installs. It reports a version bump, a newer commit without a tag, "up to date", or "local-dir install, not checked".
- **Update** runs `pnpm add <the spec your profile already records>` in a **detached child process** — it does not uninstall the plugin. If it fails, the running version keeps working; on success you restart DSH to load the new code.
- It never occupies the request: the panel polls a status file, so a 30-second install does not hang the page, and the outcome survives a closed panel.

> **Why not hot-swap?** The host half is ESM cached by URL and the client bundle is cached by the browser, so an in-place replacement cannot take effect without a restart anyway. The panel says so instead of claiming success.

**Layout: the two entry points are handled separately**

The host's layout contract differs between the centre panel and the settings page, so the shell has two modes selected by `data-surface`:

- **Centre panel (opened from the sidebar icon)**: the host supplies neither padding nor a scroll container, so the plugin provides both — centred content with breathing room (up to 48px per side, shrinking responsively on narrow windows) plus its own scrolling.
- **Settings page**: the host already renders the section inside its content column (padding and scrolling included), so the plugin adds nothing on top — no doubled inset, no nested scrollbars.

**Scrolling: long skill lists stay reachable, with no visible scrollbar**

In the centre panel only the list scrolls while **the title and tabs stay pinned to the top**, so the refresh button and tab strip remain reachable even at the bottom of a long list, with breathing room after the last row.

**No visible scrollbar at all**: the wheel, trackpad, touch, and keyboard (arrow keys / PageUp / PageDown) all keep working — only the bar is no longer drawn. The horizontal insets therefore *always* equal the inner padding: symmetric left and right regardless of content length or whether scrolling is needed, with no sideways jump when a scrollbar would have appeared or disappeared. The same rules cover modals, so long forms still scroll.

`scrollbar-gutter: stable` is deliberately *not* used: it reserves scrollbar width even when the content fits (measured: `stable` 15px, `stable both-edges` 30px), leaving an empty band on a page that has nothing to scroll. All three hiding mechanisms are declared — `scrollbar-width`, `-ms-overflow-style`, and `::-webkit-scrollbar` — so no browser falls back to a native bar that would skew the insets.

**Ordering: alphabetical, always**

List order is **predictable**, so you never have to hunt through entries:

- **Skills**: grouped by source, with a fixed group order of **project → user → plugin → other** (it does not shift as skills come and go, so group headings stay put); **alphabetical by name within each group**.
- **MCP servers**: managed and external rows are each sorted alphabetically by server name.
- **Remote sources**: sorted alphabetically by repository label.
- Sorting is **case-insensitive**: `Chrome_DevTools_MCP` sorts before `REA`, instead of all uppercase names clumping at the top. Only when two names are identical in lowercase does the raw string break the tie, keeping the order stable.
- Managed rows are written to `cordis.patch.yml` in that same order, so the file and the UI never disagree.
- Ordering is applied at the single choke point every write path goes through, so add/edit/enable/disable/delete can't bypass it.

**Skills**

- Lists every skill from all four standard roots, in official rank order: project `.dsh/skills` (100) → project `.agents/skills` (200) → user `~/.dsh/skills` (400) → user `~/.agents/skills` (500).
- Handles both layouts: directory bundles (`<name>/SKILL.md`) and flat files (`<name>.md`), plus nested/categorised trees.
- **Enable/disable is a lossless rename**: `SKILL.md` ⇄ `SKILL.md.disabled` (or `<name>.md` ⇄ `<name>.md.disabled`). The official provider only recognises the exact filenames, so the skill leaves the catalog while its files and `references/`, `scripts/`, `assets/` stay fully intact. The provider's watcher picks the change up on the next catalog refresh — **no restart**.
- Malformed skills stay listed but flagged **格式不合规 / Invalid format**, so you can fix or delete them rather than being unable to see them.
- Plugin-registered skills (no file on disk) are listed read-only.
- Create, edit, and delete skills through the built-in editor; frontmatter is validated before anything touches disk.
- **Install / update from Git**: shallow-clone a repository (or a subdirectory of one), discover every valid skill inside, and copy it to the chosen root. Records the source so you can re-pull later; `git ls-remote` tells you whether an update exists.
- **Junk directories are filtered out on write**: `.git`, `.hg`, `.svn`, `node_modules`, `__pycache__`, `.venv` and friends never land in the skill directory. When the repository root *is* the skill bundle (a `SKILL.md` at the top level), the clone's `.git` would otherwise be copied wholesale — worth several MB of commit history and remote URLs. The UI lists exactly what was skipped.
- **Type `/` in a session to pick a skill**: this plugin registers the skills it manages into DSH's skill registry, so the `/` menu matches and invokes them directly. A skill marked `disable-model-invocation: true` appears *only* there (the model never sees it), and a skill shown as disabled in the UI never appears in `/`. Changes take effect immediately — no restart.

  > Why this plugin supplies its own provider: the host-level `@deepseek-ai/dsh-skill-filesystem` row is deliberately disabled by the web app (its comment reads “presets own local discovery”), leaving each agent preset to mount its own. On some presets that provider does not actually take effect — skills on disk then appear neither in `/` nor to the model. This plugin does not depend on the preset being correct; it registers the roots it manages itself.

**Proxy: a Git proxy field above the tabs**

On many networks a direct `git clone` of a repository times out, which makes installing and updating skills impossible. A **proxy bar sits above the four tabs** — it is a prerequisite shared by every Git operation in every tab (install, update, check for updates), not a setting belonging to one of them.

- **Command-scoped, never global.** The address is injected as `git -c http.proxy=… -c https.proxy=… <subcommand>`. **Your global git config is never rewritten** — try `git config --global --get http.proxy` before and after; it is untouched. The plugin only adds flags to its own calls.
- **Off means "leave it alone", not "clear it".** With the switch off, no `-c` flags are added at all, so git falls back to whatever you configured globally (direct, or your own `git config` proxy). A `git p-on`-style global setting keeps working.
- **One Test button answers "is it the network or the repo?"** It probes the remote twice — once through the proxy and once direct — and reports both, so you can see at a glance which path is broken. If git isn't installed at all, the install dialog says so separately.
- **Credentials are treated as secrets.** A URL like `http://user:pass@host:port` has its password masked (`http://user:***@host:port`) everywhere it is sent to the browser, and is **omitted from exported bundles unless you tick "Include MCP secrets"**. The field echoes the masked form; saving it unchanged, or editing only the host/port, **keeps the stored password** rather than clearing it. If a bundle carries a masked password and this machine has none, the import plan says so instead of writing an empty one that would fail confusingly later.
- **Supported schemes**: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`. A blank or malformed address is rejected with a readable reason rather than silently disabling the proxy.
- The chosen proxy is applied **before** any clone during an import, so a bundle that carries a proxy can rescue a fresh machine that has no working direct route yet.

**MCP servers**

- Add, edit, delete and toggle `@deepseek-ai/dsh-mcp-client` rows, and inspect servers declared elsewhere in config read-only.
- Shows live state per server: enabled/disabled, reconnection phase, and how many tools are currently registered.
- Secret handling: API tokens and headers are **never read back to the browser** — only key names. Editing preserves keys you didn't retype, and lets you delete individual keys explicitly.
- Type `${MY_TOKEN}` in any env or header value and it is written as a real `!!js` expression (`\`Bearer ${process.env.MY_TOKEN}\``) — DSH has no `${VAR}` interpolation, so this is the only mechanism that actually reads the environment. The `!!js` tag round-trips byte-exactly through every edit.

**Backup: export / import your setup (for moving machines)**

The **Backup** tab packs everything this plugin manages — **Skills + MCP servers + Git source records** — into a single JSON file you can import on a new machine.

Two payload modes, chosen at export time:

| Mode | Contains | Size | On import |
|---|---|---|---|
| **Recipe** (default) | Just the source: repository + commit + layout | usually a few KB | Re-clones from the recorded repo — **needs network** |
| **Full contents** | The skill files too (binaries as base64) | can be several MB | Restores files directly — **works offline** |

- **Skills with no recoverable source always carry their contents**, in either mode — otherwise they would be lost on the new machine. That is not left to the UI to get wrong.
- **Import reviews before it writes**: the plan lists every entry's action (create / overwrite), conflicts, secrets that need re-entering, and blocked items. Nothing is written until you confirm.
- **Secrets are excluded by default.** This plugin normally never returns a secret to the browser; exporting breaks that boundary, so it takes an explicit opt-in and then shows a plain-text warning. Without it, only key names are written and you are told which ones to fill in.
- Import is **idempotent**: re-importing the same file overwrites rather than duplicating.
- If an upstream repository has moved on, the import reports that the commit it got differs from the one exported.

## Install

```bash
# From GitHub (recommended; works with any profile)
dsh plugin --profile web add github:artorias-zj/dsh-skill-mcp-tool

# The desktop profile also accepts the full URL
dsh plugin --profile desktop add https://github.com/artorias-zj/dsh-skill-mcp-tool
```

Or install from the DSH sidebar Plugins page by pointing at this directory. Then restart DSH so the client bundle is served.

> **Restart required.** The plugin's client JavaScript is addressed by URL and cached by the browser/module system. Enabling the plugin compiles and mounts the host half immediately; the settings page and sidebar entry appear after a restart.

## How hot reload works

DSH has **no runtime API to add, remove, or restart an MCP connection**. A server is a loader row, and the supported way to change it is to edit its configuration and let HMR remount the row. This plugin writes to the profile's `cordis.patch.yml`, which DSH's HMR watches, then polls the loader to confirm the row actually remounted.

- **MCP enable/disable** sets the row's `disabled` boolean → HMR disposes or mounts the connection in place.
- **MCP add/edit** rewrites the row → HMR swaps in a fresh connection. Tool names stay stable across the swap.
- **Skill enable/disable** renames a file → the provider's watcher invalidates the catalog.

The panel reports what actually happened: when a change is written but the host has not finished remounting, it says so rather than claiming success.

## Configuration isolation

MCP rows are written inside a dedicated managed block:

```yaml
# >>> dsh-skill-mcp-tool:mcp:begin
- insert:
    - id: smt-mcp-<serverName>
      name: "@deepseek-ai/dsh-mcp-client"
      config: { ... }
# <<< dsh-skill-mcp-tool:mcp:end
```

Everything outside the markers is preserved **byte for byte**, so other plugins' managed blocks (for example `dsh-skill-mcp-panel`) and your hand-written rows are never touched. Rows owned by other tools appear as read-only "external" servers. Writes take a `<file>.smt.lock` lock and use an atomic temp-file rename, so a concurrent writer cannot corrupt the file.

## Plugin configuration

Optional `config` on the row in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used to locate skill roots, the profile patch, and the source record |

## Files it touches

| Path | Purpose |
|---|---|
| `<profile>/cordis.patch.yml` | MCP server rows, inside the managed block |
| `<dshHome>/skills/**` | Skills it installs, creates, edits, or toggles |
| `<dshHome>/skill-mcp-tool/sources.json` | Index of Git install sources (an index only — deleting it never affects installed skills) |
| `<dshHome>/skill-mcp-tool/settings.json` | Plugin settings — currently just the Git proxy. Kept out of `cordis.patch.yml` on purpose: this plugin owns only the bytes between its MCP markers |
| `<dshHome>/skill-mcp-tool/update.json` | Progress of the last self-update (phase, exit code, from/to version). Written by the child process, so the panel can read it even after a restart |
| `<dshHome>/skill-mcp-tool/update.log` | Output of the last `pnpm add` run, shown in the panel on failure |

## HTTP routes

All routes are same-origin, POST-only for writes, with an origin check that rejects cross-site requests.

| Route | Purpose |
|---|---|
| `state` | Skills + MCP + sources + proxy + environment in one read |
| `skill/set-enabled`, `skill/remove`, `skill/read`, `skill/write` | Skill management |
| `skill/install`, `skill/update`, `skill/check-updates`, `skill/forget-source` | Git sources |
| `mcp/list`, `mcp/save`, `mcp/remove`, `mcp/set-enabled` | MCP management |
| `proxy/get`, `proxy/save`, `proxy/test` | Git proxy: read / write / probe both paths |
| `bundle/export`, `bundle/plan`, `bundle/import` | Settings export / review / import |
| `update/check`, `update/status`, `update/apply` | Self-update: compare with upstream / poll progress / start it |

## Plugin Info

| Field | Value |
|---|---|
| One-line value | Unified Skills + MCP manager with hot-reload toggles and Git-based skill install/update |
| Category | Skills & MCP |
| Supported profiles | desktop / web |
| Compatibility | DeepSeek Harness 0.2.x; Node.js ^22.15 or >=24; Windows / macOS / Linux |
| Permissions & services | Reads/writes the profile `cordis.patch.yml` and local skill roots; runs `git` for install/update (optionally through a proxy you configure); no telemetry |
| License | MIT |

## License

MIT
