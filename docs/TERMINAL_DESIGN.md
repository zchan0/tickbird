# Tickbird 终端版设计

状态：定稿（2026-10-06，用户确认）。带模拟画面的完整设计稿：<https://claude.ai/artifact/Pj5sM7ucJYbRxy6iZroPf4>（私有）。本文是实现时的依据，与设计稿冲突时以本文为准。

在终端里，紧挨着 Claude Code 或 Codex，按章节显示 Agent 每一轮做了什么。只读：不发消息、不执行记录里的命令。数据来自 core（解析、章节、视图模型）和插件 `tickbird-state`，与 VS Code 版共用。

## 1. 三层，不绑定任何终端

- **基础层**：任何 xterm 兼容终端都能用（含 tmux、SSH、Terminal.app、VS Code 内置终端）。只用 16 色调色板编号、粗体、暗淡、备用屏幕、SGR 鼠标。
- **增强层**：启动时向终端发查询，最后跟一个 DA1；DA1 先回答而某项没回答，就是不支持。等 DA1 最多 1 秒：通常几毫秒就回答，但 kitty 窗口在后台时要约 190ms（2026-10-06 实测）。不按终端名字判断。
- **分屏适配器**：插件 `tickbird-split` 按环境变量从内到外选适配器（kitty 里跑 tmux 时用 tmux）。都不匹配就不自动开栏，手动运行 `tickbird watch`。

## 2. 一屏一轮

- 一屏只显示一轮。轮内从上往下：请求、Changed、章节、末尾的状态行；内容超出屏幕时跟随末尾，向上滚动暂停跟随，`G` 恢复。
- 轮与轮之间：`[` `]` 上一轮、下一轮；`t` 打开**目录**（和 VS Code 版的回合目录同名）。
- 目录：最新的在上；每轮两行，第一行是请求，第二行是 `✻ … for … · N calls`（运行中的轮次写时长和调用数）；状态右对齐：运行中、等你批准、完成、中断。
- 跟随中，新一轮开始就自动翻到它。在看旧轮时不打断，底部一行提示「第 N 轮开始了」，`]` 跳到最新。

## 3. 排版

参考 Toad、OpenCode、Crush、Prowl，以及 Claude Code 和 Codex 自己的界面。

- 块与块之间空一行；同一章节的调用行连着写。左边留 2 列。
- 第一行：Agent 名（粗体）、会话标题（暗淡）、右侧状态（`● 运行中 4m 05s`、`⏸ 等你批准`）。第二行：`第 N 轮 / 共 M`、右侧开始时间。
- 请求：铺在一条底色带上（背景色往正文色移 7%），灰色标签 `Prompt`，正文粗体；页面上只有它被抬起来（2026-10-13 设计稿 v11 B）。不知道背景色时没有底色带，左侧一条灰色竖线 `┃`。Agent 的话：正常色，完整显示。调用：不铺底色，工具名粗体正文色，同一工具连续出现只写一次；调用内容灰色，树杈线更淡。本轮结束后，Final Answer、Changes 上面一条淡横线。
- 显示中的文字（`tickbird-state` 的 draft）：暗淡，终端支持时加斜体。
- 底部只有右下角一行暗淡提示：`t 目录   ⏎ 详情   ? 帮助`。没有填色横条。
- 标签 Prompt、Final Answer、Changes 是灰色，不加粗；Needs approval、Interrupted、New turn 用状态色。颜色只表示状态：红给失败和删除行，绿给新增行，金给运行中、等待圆点和选中行。
- 灰阶（2026-10-13 设计稿 v12）：终端回答了前景色（OSC 10）和背景色（OSC 11）时，用真彩色混出：调用内容和标签 60%，树杈线和横线 30%，与 VS Code 版同一套。问不到时退回调色板的灰（暗淡）。
- 出现节奏（设计稿 v12，与 VS Code 版相同）：话按字数打出，每字 5ms，120–480ms；话打完停 120ms，调用每行隔 90ms，知道颜色时分三步淡入（150ms）；排队超过 1.2 秒的直接显示。运行中，末尾一个金色圆点呼吸（1.6 秒一次），新内容出完 240ms 后才出现。

## 4. 字体

TUI 不能选字体，只保证任何字体下都对齐、分得清。

- 中文和全角标点按 2 格，英文按 1 格；断行、截断、右对齐都按格数。闭合标点不在行首。
- `● ✻ ┃ … ─` 等宽度不确定的符号：启动时逐个写一次、查询光标位置量宽度；量出 2 格的换 ASCII（`* | ...`）。
- 不用 Nerd Font 图标（配置可开）。
- 代码只在详情页（行号栏、语法高亮）；正文里的行内代码只换颜色，不加背景。
- 层级只用粗体、正常、暗淡；不用 kitty 的文字大小协议放大标题。

## 5. 详情

- 在栏内全屏打开，`Esc` 返回。
- 所有内容都是同一种面板：左栏、竖线、正文。左栏只有三种：行号（读文件）、`+` `-`（改文件，整文件写入全是 `+`）、空白（命令、参数、返回）。参数写成「名字: 值」，和调用标题重复的描述不再显示。段落标题只有「输入」「返回」，多次读取或多个文件时再加一行同样的小标题。
- 读文件：文件名、路径、读到的行号范围、语法高亮。
- 改文件：当时的 diff；同一文件在本轮的多次修改用 `<` `>` 切换。不显示修改的行号：Edit 和 apply_patch 的记录通常没有行号，不推测。
- `o` 在编辑器打开文件（打开的是磁盘上现在的文件）：依次用 `$VISUAL`、`$EDITOR`、VS Code、系统默认程序；vim 等终端编辑器在栏内打开，退出后回到详情。`y` 复制路径或命令：终端支持 OSC 52 时直接复制，否则在底部显示全文供手动复制。`[` `]` 上一个、下一个调用。

## 6. 等你批准

- 最新一轮末尾的状态行换成 `▌ 等你批准  工具 · 摘要`，第二行提示去 Agent 那里处理。
- 标签页标题同时改变（OSC 0/2）。
- 栏不在前台时发桌面通知；默认不响铃。
- 判断规则同 VS Code 版：`awaitingApproval(state, 会话记录最后时间)`。

## 7. 按键与鼠标

按 vim / less 的习惯，同一个键在各页意思一致。

| 键 | 意思 | 轮页 | 详情 | 目录 |
| --- | --- | --- | --- | --- |
| `j` `k` / `↓` `↑` | 移动 | 选择调用（选中后暂停跟随） | 滚动 | 选择轮 |
| `⏎` | 进入 | 打开详情 | — | 打开这一轮 |
| `Esc` | 返回上一层 | 取消选择 | 回到轮页 | 回到轮页 |
| `q` | 退出 | 退出 | 退出 | 退出 |
| `[` `]` | 同一层的上一个 / 下一个 | 上一轮 / 下一轮 | 上一个 / 下一个调用 | — |
| `<` `>` | 同一文件的上一次 / 下一次修改 | — | 切换修改 | — |
| `g` `G` | 开头 / 末尾 | 本轮开头 / 最新一轮末尾并恢复跟随 | 同左 | 最新 / 最早 |
| `␣` `b` / `Ctrl-d` `Ctrl-u` | 整页 / 半页 | 滚动 | 滚动 | — |
| `t` `o` `y` `?` | 目录 / 在编辑器打开 / 复制 / 帮助 | 同左 | 同左 | — |
| `/` `n` `N` | 搜索（以后做） | | | |
| `a` | 切回 Agent（有分屏适配器时才显示） | | | |

鼠标：单击调用选中，再单击打开；单击「第 N 轮」打开目录；滚轮滚动（向上暂停跟随）；⌘ 单击详情页顶部的文件名打开文件（终端支持链接时）。

能打开详情的调用行，右端有暗淡的 `→`；选中时只用这一个标记：箭头变黄，工具名不再暗淡，标签加粗。

按键只做阅读和跳转，绝不向 Agent 窗口输入任何东西。

## 8. 能力探测

| 能力 | 探测 | 用途 | 不支持时 |
| --- | --- | --- | --- |
| 防闪烁刷新 | DECRQM 模式 2026 | 整帧原子刷新 | 只重画变化的行 |
| 可点击链接 | 无法查询：默认开；`TERM=dumb`、`linux` 关；tmux 看 hyperlinks | 文件路径 ⌘ 单击打开 | 普通文字，`o` 打开 |
| 图片 | kitty 图形查询（`a=q`）；iTerm2 图片看 XTVERSION | 请求截图缩略图 | `[图 1 · 宽×高 · ⏎ 打开]`，用系统看图打开 |
| 桌面通知 | OSC 99 查询；否则按 XTVERSION 选 OSC 9 / 777 | 等你批准、回合结束 | 响铃 + 标签页标题 |
| 增强键盘 | `CSI ? u` | 分清 Esc 与 Alt 组合 | 普通按键 |
| 背景色、前景色 | OSC 11、OSC 10 | Prompt 底色带、真彩色灰阶、等待圆点 | 没有底色带，灰色用暗淡 |
| 剪贴板 | XTGETTCAP `Ms` | `y`（OSC 52） | 在底部显示，手动复制 |
| 符号宽度 | 写符号后查询光标位置 | 决定用符号还是 ASCII | 用 ASCII |

tmux 里：图片和通知需要 `allow-passthrough on`，链接需要 `terminal-features` 含 `hyperlinks`；探测穿过 tmux 问外层终端，没放行的按不支持处理。

## 9. 分屏适配器（插件 `tickbird-split`）

会话开始时开栏，焦点留在 Agent；`/clear`（Codex 是 `/new`）后同一栏改绑新会话；Agent 退出或被强杀时栏自己退出；栏里按 `a` 切回 Agent。

插件只有一个 `SessionStart` hook。栏按 **Agent 进程**绑定（`watch --agent <pid>`），不按会话：同一进程的新会话在 `tickbird-state` 里有新的 `start`，栏自己改绑；进程消失，栏 1 秒内退出。所以不需要 `SessionEnd` hook。切回 Agent 的命令由插件算好，用 `--focus <JSON 参数数组>` 传给栏，栏不需要认识终端。

### 两层适配

hook 只能知道三样东西：谁启动了它、启动者的环境变量、Agent 发来的会话信息。hook 在哪个进程里运行，决定了它知道什么。所以适配分两层：

1. **Agent 层：找到会话的前台**（`scripts/front.mjs`，`tickbird-state` 里有同一份）。
2. **终端层：在前台旁边开栏**（`scripts/adapters/`）。只用第 1 层给出的进程和环境变量，不关心是哪个 Agent。

| Agent 的结构 | 例子 | 前台 | 怎么得到 |
| --- | --- | --- | --- |
| 一个会话一个进程，在终端里 | Claude Code；Codex 带 `-c`、`--no-daemon` 等（embedded） | 启动 hook 的 Agent | 直接得到，环境变量就是 hook 的 |
| 编辑器托管 | VS Code 里的 Claude Code、Codex | 所在的 VS Code 窗口 | 不开栏（没有终端）；VS Code 版用 `hostPid` |
| 共用后台 | Codex 0.157 起的默认方式 | 终端里的 `codex` 前台 | 见下 |
| 后台会话 | `claude --bg`（每个会话仍是独立进程，在 `claude daemon` 给的虚拟终端里） | 没有，或 `claude attach` 所在的窗格 | 暂不支持：不开栏 |

**Codex 共用后台**（2026-10-08 实测 Codex 0.160–0.161）：所有终端里的 `codex` 只负责显示，hook 在共用后台（`codex app-server … --managed-daemon`）里运行。后台的环境变量来自第一个启动它的终端，和当前窗格无关；后台不随会话退出，还会随 Codex 自动升级换进程。识别到这个后台时，按下面的顺序找前台：

1. 有终端的 `codex` 进程中，当前目录与会话目录相同的（macOS 用 `lsof`，Linux 用 `/proc`）。
2. 只有一个就用它。有几个时，取终端最近收到输入的那个（终端设备的访问时间，`w` 的空闲时间也用它）：Codex 在发出第一条消息时才开始会话。它必须在 30 秒内，并且比第二个早至少 2 秒，否则不开栏。
3. 读它的环境变量（macOS 用 `ps -E`，Linux 用 `/proc/<pid>/environ`），交给终端层。

不能用"前台已有别的会话"来排除：Codex 的 `/new` 不结束旧会话。协议（app-server JSON-RPC）里也没有"哪个客户端打开了这个会话"。

### 终端层

| 终端或复用器 | 识别 | 确认 Agent 就在这里 | 开栏 | 切回 Agent | 状态 |
| --- | --- | --- | --- | --- | --- |
| tmux | `TMUX`、`TMUX_PANE` | 前台的终端等于窗格的 `pane_tty` | `split-window -h -d -l 35%`，窗格选项 `@tickbird_agent` | `select-window` + `select-pane` | 已做 |
| kitty | `KITTY_WINDOW_ID`，且 `TERM=xterm-kitty` 或没有 `TERM_PROGRAM`；需要 `KITTY_LISTEN_ON` | 前台在窗口的前台进程里 | `launch --location=vsplit --keep-focus --bias=35`，用户变量 `tickbird_agent` | `focus-window` | 已做 |
| Zellij、WezTerm、iTerm2 | `ZELLIJ`、`WEZTERM_PANE`、`ITERM_SESSION_ID` | | | | 识别，不开栏 |
| 其它 | 不匹配 | | 不开栏；手动 `tickbird watch` | 不显示 `a` | |

按从内到外的顺序试（tmux 先于 kitty）。环境变量可能是从别的终端继承来的（比如从 kitty 里启动的 Terminal.app 带着 `KITTY_WINDOW_ID`），所以每个适配器都要确认 Agent 真在它的窗格里；不确定就不开栏，绝不开到别的窗口旁边。

不开栏时，原因写进 `~/.local/state/tickbird/split.log`；hook 没有任何输出。栏从 Agent 的环境里带上 `PATH`、`XDG_STATE_HOME`、`VISUAL`、`EDITOR`（kitty 的新窗口只有 kitty 自己的环境）。栏的程序：`$TICKBIRD_CLI`（脚本或程序），否则 PATH 上的 `tickbird`。

不想自动分屏：在 Agent 的插件管理里停用 `tickbird-split`。

## 10. 代码结构

```
packages/core/          turn-view, session-state, parsers    shared with VS Code
packages/terminal/
  caps/                 queries at start -> Capabilities
  screen/               cell buffer, line diff, sync output, OSC 8 / 52 / 99 writers
  input/                keys (legacy + kitty protocol), SGR mouse
  views/                turn page, contents, detail (file, diff, output), search, picker, help
  app.ts                selection, follow, binding from session state
plugins/tickbird-state/  session state hooks                  shared with VS Code
plugins/tickbird-split/  open the pane beside the session's front (front.mjs), tell it how to focus the agent
  adapters/             tmux, kitty; zellij, wezterm, iterm2 recognised only
```

渲染层自己写，不用 Ink 等框架：要细控的是图片、链接、同步刷新、增强键盘等终端协议。宽度与断行规则沿用原型（`terminal-prototype` 分支的 `packages/terminal/src/width.ts`）。
