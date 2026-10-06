# Sidecar 终端版设计

状态：定稿（2026-10-06，用户确认）。带模拟画面的完整设计稿：<https://claude.ai/artifact/Pj5sM7ucJYbRxy6iZroPf4>（私有）。本文是实现时的依据，与设计稿冲突时以本文为准。

在终端里，紧挨着 Claude Code 或 Codex，按章节显示 Agent 每一轮做了什么。只读：不发消息、不执行记录里的命令。数据来自 core（解析、章节、视图模型）和插件 `sidecar-state`，与 VS Code 版共用。

## 1. 三层，不绑定任何终端

- **基础层**：任何 xterm 兼容终端都能用（含 tmux、SSH、Terminal.app、VS Code 内置终端）。只用 16 色调色板编号、粗体、暗淡、备用屏幕、SGR 鼠标。
- **增强层**：启动时向终端发查询，最后跟一个 DA1；DA1 先回答而某项没回答，就是不支持。总限时 150ms。不按终端名字判断。
- **分屏适配器**：插件 `sidecar-split` 按环境变量从内到外选适配器（kitty 里跑 tmux 时用 tmux）。都不匹配就不自动开栏，手动运行 `agent-sidecar watch`。

## 2. 一屏一轮

- 一屏只显示一轮。轮内从上往下：请求、Changed、章节、末尾的状态行；内容超出屏幕时跟随末尾，向上滚动暂停跟随，`G` 恢复。
- 轮与轮之间：`[` `]` 上一轮、下一轮；`t` 打开**目录**（和 VS Code 版的回合目录同名）。
- 目录：最新的在上；每轮两行，第一行是请求，第二行是 `✻ … for … · N calls`（运行中的轮次写时长和调用数）；状态右对齐：运行中、等你批准、完成、中断。
- 跟随中，新一轮开始就自动翻到它。在看旧轮时不打断，底部一行提示「第 N 轮开始了」，`]` 跳到最新。

## 3. 排版

参考 Toad、OpenCode、Crush、Prowl，以及 Claude Code 和 Codex 自己的界面。

- 块与块之间空一行；同一章节的调用行连着写。左边留 2 列。
- 第一行：Agent 名（粗体）、会话标题（暗淡）、右侧状态（`● 运行中 4m 05s`、`⏸ 等你批准`）。第二行：`第 N 轮 / 共 M`、右侧开始时间。
- 请求：左侧蓝色竖线 `┃` 加粗体。Agent 的话：`●` 开头，正常色，完整显示。调用行：缩进在章节下，工具名暗淡，同一工具连续出现只写一次。
- 显示中的文字（`sidecar-state` 的 draft）：暗淡，终端支持时加斜体。
- 底部只有右下角一行暗淡提示：`t 目录   ⏎ 详情   ? 帮助`。没有填色横条。
- 颜色只用调色板编号：红只给真失败；黄只给进行中和等你批准；蓝只给请求竖线和链接；其余次要信息用暗淡。

## 4. 字体

TUI 不能选字体，只保证任何字体下都对齐、分得清。

- 中文和全角标点按 2 格，英文按 1 格；断行、截断、右对齐都按格数。闭合标点不在行首。
- `● ✻ ┃ … ─` 等宽度不确定的符号：启动时逐个写一次、查询光标位置量宽度；量出 2 格的换 ASCII（`* | ...`）。
- 不用 Nerd Font 图标（配置可开）。
- 代码只在详情页（行号栏、语法高亮）；正文里的行内代码只换颜色，不加背景。
- 层级只用粗体、正常、暗淡；不用 kitty 的文字大小协议放大标题。

## 5. 详情

- 在栏内全屏打开，`q` 返回。
- 读文件：文件名、路径、读到的行号范围、行号栏、语法高亮。
- 改文件：当时的 diff，双行号；同一文件多次修改用 `‹ ›` 切换。
- 其它调用：输入与返回。
- `o` 在编辑器打开文件：依次用 `$VISUAL`、`$EDITOR`、VS Code、系统默认程序，可配置。`y` 复制路径或命令。`n` `p` 下一个、上一个调用。

## 6. 等你批准

- 最新一轮末尾的状态行换成 `▌ 等你批准  工具 · 摘要`，第二行提示去 Agent 那里处理。
- 标签页标题同时改变（OSC 0/2）。
- 栏不在前台时发桌面通知；默认不响铃。
- 判断规则同 VS Code 版：`awaitingApproval(state, 会话记录最后时间)`。

## 7. 按键与鼠标

| 操作 | 按键 | 鼠标 |
| --- | --- | --- |
| 选择上一行 / 下一行 | `↑` `↓` / `k` `j` | 单击 |
| 打开详情 | `⏎` | 双击 |
| 上一轮 / 下一轮 | `[` `]` | — |
| 打开目录 | `t` | 单击「第 N 轮」 |
| 翻页 / 本轮开头 / 本轮末尾并恢复跟随 | `␣` / `g` / `G` | 滚轮向上暂停跟随 |
| 搜索 | `/`，`n` `N` | — |
| 切回 Agent | `a`（有适配器时才显示） | — |
| 在编辑器打开 / 复制 | `o` / `y` | ⌘ 单击链接 |
| 切换会话 / 帮助 / 返回或退出 | `s` / `?` / `q` | — |

按键只做阅读和跳转，绝不向 Agent 窗口输入任何东西。

## 8. 能力探测

| 能力 | 探测 | 用途 | 不支持时 |
| --- | --- | --- | --- |
| 防闪烁刷新 | DECRQM 模式 2026 | 整帧原子刷新 | 只重画变化的行 |
| 可点击链接 | 无法查询：默认开；`TERM=dumb`、`linux` 关；tmux 看 hyperlinks | 文件路径 ⌘ 单击打开 | 普通文字，`o` 打开 |
| 图片 | kitty 图形查询（`a=q`）；iTerm2 图片看 XTVERSION | 请求截图缩略图 | `[图 1 · 宽×高 · ⏎ 打开]`，用系统看图打开 |
| 桌面通知 | OSC 99 查询；否则按 XTVERSION 选 OSC 9 / 777 | 等你批准、回合结束 | 响铃 + 标签页标题 |
| 增强键盘 | `CSI ? u` | 分清 Esc 与 Alt 组合 | 普通按键 |
| 背景深浅 | OSC 11 | 调整暗淡、选中行对比度 | 按深色处理 |
| 剪贴板 | XTGETTCAP `Ms` | `y`（OSC 52） | 在底部显示，手动复制 |
| 符号宽度 | 写符号后查询光标位置 | 决定用符号还是 ASCII | 用 ASCII |

tmux 里：图片和通知需要 `allow-passthrough on`，链接需要 `terminal-features` 含 `hyperlinks`；探测穿过 tmux 问外层终端，没放行的按不支持处理。

## 9. 分屏适配器（插件 `sidecar-split`）

会话开始时开栏，焦点留在 Agent；会话结束或 Agent 进程消失时关栏；`/clear` 后同一栏改绑新会话（从 `sidecar-state` 的状态文件读，不用原型的绑定文件）。

| 终端或复用器 | 识别 | 开栏 | 切回 Agent | 优先级 |
| --- | --- | --- | --- | --- |
| kitty | `KITTY_LISTEN_ON`、`KITTY_WINDOW_ID` | `kitten @ launch --location=vsplit --next-to … --keep-focus` | `kitten @ focus-window`，窗口号来自 `sidecar-state` | 先做（原型已实测开栏） |
| tmux | `TMUX`、`TMUX_PANE` | `tmux split-window -h -d -l 35% -t $TMUX_PANE` | `tmux select-pane -t <窗格>` | 先做 |
| WezTerm | `WEZTERM_PANE` | `wezterm cli split-pane --right --percent 35`，再切回焦点 | `wezterm cli activate-pane` | 接口留好 |
| iTerm2 | `ITERM_SESSION_ID` | AppleScript 纵向分屏并运行命令 | AppleScript 按会话 ID 选中 | 接口留好 |
| Zellij | `ZELLIJ` | `zellij run --direction right -- …` | `zellij action move-focus`（只能按方向） | 接口留好 |
| 其它 | 不匹配 | 不自动开栏；手动 `agent-sidecar watch`（取当前目录最新会话） | 不支持，不显示 `a` | — |

不想自动分屏：在 Agent 的插件管理里停用 `sidecar-split`。

## 10. 代码结构

```
packages/core/          turn-view, session-state, parsers    shared with VS Code
packages/terminal/
  caps/                 queries at start -> Capabilities
  screen/               cell buffer, line diff, sync output, OSC 8 / 52 / 99 writers
  input/                keys (legacy + kitty protocol), SGR mouse
  views/                turn page, contents, detail (file, diff, output), search, picker, help
  app.ts                selection, follow, binding from session state
plugins/sidecar-state/  session state hooks                  shared with VS Code
plugins/sidecar-split/  open / rebind / close the pane, focus the agent
  adapters/             kitty, tmux, wezterm, iterm2, zellij
```

渲染层自己写，不用 Ink 等框架：要细控的是图片、链接、同步刷新、增强键盘等终端协议。宽度与断行规则沿用原型（`terminal-prototype` 分支的 `packages/terminal/src/width.ts`）。
