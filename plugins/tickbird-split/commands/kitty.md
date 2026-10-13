---
description: 检查并打开 kitty 的远程控制（Tickbird 在 kitty 里自动分屏需要）
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/program/tickbird.cjs" kitty`

上面是 Tickbird 对 kitty 配置的检查结果。

- 如果显示「已开启」，或者这台机器没有 kitty：告诉用户不需要做什么。
- 如果还没开启：用一句话说明要在 kitty.conf 末尾加上面列出的两行（Tickbird 会先备份原文件），问用户是否同意。用户同意后运行 `node "${CLAUDE_PLUGIN_ROOT}/program/tickbird.cjs" kitty --apply`，把它的输出告诉用户，并提醒：要完全退出 kitty 再打开才生效，只关窗口不够。用户不同意就什么都不改。
