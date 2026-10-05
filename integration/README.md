# Agent Sidecar 接入

给 Claude Code 和 Codex 的一组 hook。它把每个会话「属于哪个窗口、是否在等你批准、屏幕上正在显示的长回答」追加写到本机的状态文件，VS Code 版和终端版读这些文件。它不显示任何东西，不改变 Agent 的行为，hook 的输出始终为空。格式见 [SESSION_STATE.md](../SESSION_STATE.md)。

- 同一个目录既是 Claude Code 插件（`.claude-plugin/plugin.json`），也是 Codex 插件（`.codex-plugin/plugin.json`），共用 `scripts/hook.mjs`。
- 状态文件在 `~/.local/state/agent-sidecar/sessions/`（或 `$XDG_STATE_HOME/agent-sidecar/sessions/`），一个会话一个文件，权限 0600。
- 只依赖 Node 自带模块。

## 本地试用

- Claude Code：`claude --plugin-dir <仓库>/integration`
- Codex：插件要从插件市场安装，安装流程在 VS Code 版和终端版的私有安装里做。装上后要在 Codex CLI 里执行一次 `/hooks` 信任这些 hook，否则 Codex 会静默跳过它们。

停用：在 Claude Code 的 `/plugin`、Codex 的 `/plugins` 里关掉 agent-sidecar。
