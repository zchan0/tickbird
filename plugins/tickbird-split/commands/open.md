---
description: 在 kitty 或 tmux 里，为这个会话打开 Tickbird 窗格（被关掉之后重新打开）
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/split.mjs" claude --open`

上面是 Tickbird 打开窗格的结果。用一句话告诉用户：开好了、已经开着，或者为什么没开（比如不在 kitty 或 tmux 里，或 kitty 没开远程控制，这时提示运行 /tickbird-split:kitty）。
