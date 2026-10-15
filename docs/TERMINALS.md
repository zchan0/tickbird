# 终端支持

装了终端版后，新开的 Claude Code 或 Codex 会话旁边会自动开一栏 Tickbird，焦点留在 Agent。已经开着的会话不受影响。原理见 [TERMINAL_DESIGN.md](./TERMINAL_DESIGN.md) 第 9 节。

| 终端 | 自动开栏 | 说明 |
| --- | --- | --- |
| kitty | ✅ | 要开远程控制：在 Claude Code 里运行 `/tickbird-split:kitty`，它会检查，经你同意后备份 kitty.conf 并加上两行；之后完全退出 kitty 再打开 |
| tmux（在任何终端里） | ✅ | 不需要设置 |
| WezTerm | ✅ 未实测 | 按 WezTerm 的文档实现（`wezterm cli split-pane`） |
| Zellij | ✅ 未实测 | 按 Zellij 的文档实现；新栏先开在右边，再挪到左边 |
| iTerm2（macOS） | ✅ 未实测 | 通过 AppleScript，新栏在 Agent 右边；第一次会请你允许控制 iTerm2 |
| Ghostty（macOS，1.3 以上） | ✅ 未实测 | 通过 AppleScript（Ghostty 标为预览）；分出的是当时窗口里正在用的那个终端；第一次会请你允许控制 Ghostty |
| 其它终端 | — | 在 Claude Code 里运行 `/tickbird-split:open`，它给出一行命令并复制到剪贴板，在新的标签页或窗口里运行即可 |

栏被关掉了，用 `/tickbird-split:open` 重新打开。不想自动开栏，在 Agent 的插件管理里停用 `tickbird-split`。
