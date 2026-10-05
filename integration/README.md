# Agent Sidecar 接入

给 Claude Code 和 Codex 的一组 hook。它把每个会话「属于哪个窗口、是否在等你批准、屏幕上正在显示的长回答」追加写到本机的状态文件，VS Code 版和终端版读这些文件。它不显示任何东西，不改变 Agent 的行为，hook 的输出始终为空。格式见 [SESSION_STATE.md](../SESSION_STATE.md)。

- 同一个目录既是 Claude Code 插件（`.claude-plugin/plugin.json`），也是 Codex 插件（`.codex-plugin/plugin.json`），共用 `scripts/hook.mjs`。
- 状态文件在 `~/.local/state/agent-sidecar/sessions/`（或 `$XDG_STATE_HOME/agent-sidecar/sessions/`），一个会话一个文件，权限 0600。
- 只依赖 Node 自带模块。

## 版本

接入和产品用同一个版本号：`package.json` 和两份插件清单（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`）必须一致，测试会检查。改版本只用 `npm run set-version -- x.y.z`，不要手改某一个文件。

Claude Code 和 Codex 都按版本号缓存已装的插件：改了 `integration/` 里任何文件，都要升一次版本，再运行 `npm run install:vscode`，否则已装的插件不会更新。Codex 的 hook 定义（命令那一行）一改，还要在 `/hooks` 里重新信任；只改脚本内容不需要。

## 本地试用

- Claude Code：`claude --plugin-dir <仓库>/integration`
- 正式安装：`npm run install:vscode` 把本仓库登记为 Claude Code 和 Codex 的本地插件市场（`.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`），并装上接入。
- Codex 装上后要在 Codex CLI 里执行一次 `/hooks`、按 `t` 信任这些 hook，否则 Codex 会静默跳过它们。Codex 把 `SessionEnd`、`Interrupt` 的超时限制在 3 秒，清单里按此设置。

停用：在 Claude Code 的 `/plugin`、Codex 的 `/plugins` 里关掉 agent-sidecar。
