# 终端版实现计划

按 [TERMINAL_DESIGN.md](./TERMINAL_DESIGN.md) 实现。每一步都要：

1. 单元测试全部通过（原有测试也不能坏）。
2. 按本步的端到端步骤，在真实终端里跑一遍。
3. 交出审阅产物：截图和报告，审阅通过后才进入下一步。

**截图怎么来**：用 `kitten @ get-text --ansi` 取出终端里真实显示的每一格（含颜色），按格排版成图片。它和屏幕上的内容逐格一致，不受窗口位置、屏幕录制权限的影响。

**测试环境**：一个单独启动的 kitty 实例（只对它开启 socket 远程控制，不改你的 kitty 配置），以及在它里面运行的 tmux（默认配置）。真实的 Claude Code 和 Codex 会话，在需要的步骤里用测试目录里的简单请求生成。

## C2-1 渲染与输入底座

- 内容：宽度与断行（沿用原型）；单元格缓冲与逐行比较刷新（支持时整帧同步刷新）；按键（含 kitty 键盘协议）与 SGR 鼠标解析；能力探测；两个调试命令：`tickbird caps` 打印探测结果，`tickbird demo` 显示一幅测试画面并回显按键。
- 单元测试：宽度与断行；刷新只输出变化的行；按键与鼠标序列解析；用脚本模拟终端的回答测探测，包括不回答、超时、tmux 包装。
- 端到端：
  1. 测试 kitty 里运行 `caps`：期望防闪烁、链接、图片、通知、增强键盘、背景色、剪贴板都探测为可用，符号宽度全是 1 格。
  2. 同一 kitty 里的 tmux 中运行 `caps`：期望图片和通知不可用（tmux 默认不放行），其余按 tmux 实际回答；状态栏的窗格标题不变（tmux 会把图片查询当成标题，所以在 tmux 里不发这条查询）。
  3. 以 `TERM=dumb` 运行 `caps`：期望全部按不支持处理，且不往屏幕输出任何查询序列。
  4. 测试 kitty 里运行 `demo`：截图检查中英文对齐、符号、16 色；用 `kitten @ send-key` 发送 `↑ ↓ ⏎ Esc Alt+x Ctrl+c`，检查回显；调整窗口宽度，检查重画不残留。
- 审阅产物：三份 `caps` 报告；`demo` 截图（kitty 一张、tmux 一张、改宽度后一张）。
- 结果（2026-10-06，kitty 0.48.2、tmux 3.6a）：
  - kitty：各项都可用，12 个符号都是 1 格。
  - tmux：只回答背景色、版本、光标位置和 DA1。防闪烁查询（DECRQM 2026）没有回答，按不可用处理。
  - `TERM=dumb`：输出里没有 Esc 字节。
  - 端到端发现并修复：tmux 把图片查询当成窗格标题，探测结束后标题也不恢复。

## C2-2 一屏一轮

- 内容：轮页（请求、Changed、章节、末尾状态）；跟随与暂停；`[` `]`；目录；读取 `tickbird-state`（等你批准、显示中的文字）；新一轮开始的提示；`tickbird watch`（参数绑定会话，或取当前目录最新会话）。
- 单元测试：用合成会话测排版（每行不超过栏宽、块间空行、调用行缩进）、目录条目、跟随与暂停的状态切换、等你批准的判断。
- 端到端：
  1. 测试 kitty 里开一个真实 Claude Code 会话，另一个窗口运行 `watch`；发一条会调用工具的消息，过程中每隔几秒截图。
  2. 让它停在批准提示：截图检查「等你批准」。
  3. 再发一条消息：检查自动翻到新一轮；先按 `[` 回到上一轮，再发消息，检查底部提示。
  4. 打开目录，截图。
  5. 同样流程用 Codex 跑一遍。
  6. 40 列窄栏截图一张。
- 审阅产物：上述截图（实时过程一组、等你批准、目录、旧轮提示、窄栏），以及 Codex 的一组。
- 结果（2026-10-06，Claude Code 2.1.290、Codex 0.160.1，均在测试 kitty 里）：
  - 两个 Agent 都通过：实时过程、等你批准、自动翻到新一轮、旧轮提示和 `]`、目录、40 列窄栏、Agent 退出后显示「已退出」、按会话 ID 打开。
  - 端到端发现并修复：
    - Markdown 表格原样显示 → 排成对齐的列，放不下时每行一条。
    - 英文单词紧跟中文标点时被断开、网址在 `:` 处被断开 → 整词换行。
    - 窄栏工具名被截成 `Writ` → 窄栏工具列 5 列。
    - kitty 窗口在后台时回答要约 190ms，超过 150ms 的探测限时，符号偶尔退成 ASCII → 等 DA1 最多 1 秒。
    - Markdown 只支持一部分（斜体、链接、删除线、分隔线、任务列表原样显示）→ 改用 markdown-it 解析（与 VS Code 版一致）：表格画边框、在格子里换行，太窄时改成一行一个字段；链接显示文字和暗淡的网址，不可点击（与 VS Code 版相同）；代码块截断处标 `…`。
    - 断行：单词放得进一整行就整个换行；开括号不留在行尾，闭合标点连同前面的单词一起换行。
  - 截图工具：Chrome 截完即结束（1 秒一张）；`--capture-only` 先抓内容（0.2 秒），之后再出图，用来抓实时过程。

## C2-3 详情

- 内容：文件阅读、diff（多次修改切换）、调用的输入与返回；`o` `y` `n` `p`；链接与剪贴板按探测结果启用。
- 单元测试：文件阅读的行号范围、diff 双行号、截断与换行。
- 端到端：在 C2-2 的会话里，对 Read、Edit、Bash 各打开一次详情并截图；`o` 打开文件（检查编辑器确实打开到对应行）；`y` 后读取剪贴板核对内容；在 tmux 里重复 `y`，检查按探测结果退回「显示出来」。
- 审阅产物：三种详情截图；`o` 和 `y` 的结果记录。
- 结果（2026-10-06，Claude Code 2.1.290，测试 kitty 与 tmux 3.6a）：
  - Read、两次 Edit（`‹ ›` 切换）、Bash 的详情都正确；`VISUAL=vim` 时 `o` 在栏内打开、退出后回到详情；kitty 里 `y` 写入剪贴板（`pbpaste` 核对），tmux 里剪贴板不变、底部显示全文。
  - 发现并修复：读到的文件末尾空行被丢掉；底部按键提示过长被截断（改为放不下就省略靠后的提示）；只重复描述的参数块。
  - 设计调整（审阅后）：详情统一成一种面板，左栏只有行号、`+` `-` 或空白，diff 不显示行号；能打开的调用行右端加 `→`；按键统一成 vim / less 习惯（见设计文档第 5、7 节）。

## C2-4 插件 `tickbird-split`

- 内容：kitty 与 tmux 适配器：开栏、`/clear` 后改绑、退出关栏、Agent 进程消失时自动退出、`a` 切回 Agent；其它终端不开栏。
- 单元测试：适配器选择（环境变量组合、kitty 里套 tmux）；hook 输出为空；命令参数。
- 端到端（kitty 和 tmux 各一遍，Claude Code 和 Codex 都跑）：启动 Agent 后截图（栏自动出现、焦点在 Agent）；`/clear` 后截图（同一栏改绑）；在栏里按 `a`，检查焦点回到 Agent；退出 Agent，检查栏关闭；强杀 Agent，检查栏自己退出；在 Terminal.app 里启动，检查不开栏、无报错。
- 审阅产物：每个场景的截图或窗口列表记录。
- 结果（2026-10-08，kitty 0.48.2、tmux 3.6a、Claude Code 2.1.293、Codex 0.160.1 / 0.161.0）：
  - kitty 和 tmux 里，Claude Code、Codex（embedded 和共用后台两种方式）都通过：自动开栏且焦点留在 Agent、`/clear` 或 `/new` 后同一栏改绑、`a` 切回、正常退出和 `kill -9` 后栏关闭。Terminal.app 不开栏、无报错。
  - 同一目录两个 Codex（共用后台）：栏开在刚发消息的那个旁边；另一个 `/new` 后各自的栏只跟自己的会话。
  - 端到端发现并修复：
    - Codex 0.157 起 hook 在共用后台里运行，`$PPID` 是后台、环境变量来自第一个启动它的终端 → 增加 Agent 层（`front.mjs`）：找终端里的 `codex` 前台；`tickbird-state` 也记录前台（新增 `serverPid`）。
    - "前台已有别的会话"不能用来区分同目录的几个 Codex（`/new` 不结束旧会话）→ 改用终端最近收到输入的时间。
    - 栏只在默认目录找会话记录，自定义 `CODEX_HOME` 找不到 → 按状态文件里的 `transcript` 打开。
    - 从 kitty 里启动的 Terminal.app 带着 `KITTY_WINDOW_ID`，日志误报为 kitty 没开远程控制 → kitty 还要求 `TERM=xterm-kitty` 或没有 `TERM_PROGRAM`。
  - 设计调整：栏按 Agent 进程绑定并自己改绑、自己退出，插件不需要 `SessionEnd` hook；切回命令由插件用 `--focus` 传给栏。

## C2-5 盘点 hook：基础功能不依赖 hook

- 目标：不装 hook 也能用；hook 只做增强（更早、更全）。先核实各项功能有没有不靠 hook 的来源，再决定改不改、改哪些。这一步决定 C3 装什么，所以放在 C3 之前。
- 背景：hook 是公开、有文档的接口；下面的替代来源大多是内部文件或内部协议，可能随版本变化。换掉 hook 是用一种脆弱换另一种，要逐项权衡，不能只看能不能绕过去。

| 功能 | 现在用的 hook | Claude Code 不用 hook | Codex 不用 hook |
| --- | --- | --- | --- |
| 会话属于哪个进程、哪个窗口 | SessionStart | `~/.claude/sessions/<pid>.json` + 进程树 | 终端：新会话记录出现后，按 `front.mjs` 找前台；VS Code：待查 |
| 工作中 / 空闲 | UserPromptSubmit、Stop | 同一文件的 `status` | 会话记录里的事件；或后台协议的线程状态 |
| 等你批准 | PermissionRequest | `status: waiting`、`waitingFor: "permission prompt"`；工具取自会话记录 | 后台协议 `activeFlags: waitingOnApproval`（待验证） |
| 提前显示长回答 | MessageDisplay | 没有替代 | Codex 本来就没有 |
| 会话结束 | SessionEnd | 进程消失、文件删除 | 前台进程消失 |
| 自动开栏 | SessionStart（tickbird-split） | 要有触发：hook、包一层启动命令，或我们自己的常驻进程 | 同左 |

- 已核实（2026-10-08）：
  - Claude Code 2.1.293 为每个进程写 `~/.claude/sessions/<pid>.json`（未公开）：`sessionId`（`/clear` 后变）、`cwd`、`kind`、`entrypoint`、`status`（`idle` → `busy` → `waiting` + `waitingFor: "permission prompt"`，拒绝后回到 `idle`），在 tmux 里还有自己的窗格（`tmux: "<会话>:@<窗口>.%<窗格>"`）；进程退出时删除。
  - Codex 0.160.1 的后台控制 socket（`~/.codex/app-server-control/app-server-control.sock`）说 WebSocket（`GET /rpc`），上面是 JSON-RPC。外部客户端只调用 `initialize`、`thread/loaded/list`、`thread/read` 就能读到每个已加载线程的状态（`idle`、`active`、`systemError`）；实测看到 `idle` → `active` 的变化。`codex app-server proxy` 只转发原始字节，不做 WebSocket 握手。
- 待核实：
  1. 等批准时，`thread/read` 的状态是否带 `waitingOnApproval`（实测因 Codex 用量到达上限而中断）。
  2. VS Code 里的 Claude Code 是否也写 `~/.claude/sessions/<pid>.json`，`entrypoint` 是什么；VS Code 里的 Codex（扩展自己的 app-server）能否同样读到线程和所属进程。
  3. 不用 hook 时怎样触发自动开栏：包一层启动命令、监视会话目录，还是保留 hook 只做这一件事。
- 决定（2026-10-08，用户确认）：两个 Agent 都用命令型 hook 和外部分屏，不用 Claude Code 的 mods。原因：mods 窗格是横在对话和输入框之间的整宽方框，不是侧栏，放不下一轮的内容，还会挤占对话；mods 接口是 EARLY ACCESS；两个 Agent 用同一套做法更统一。hook 要做得克制：只保留会话记录里没有、或来得太晚的信息。下面 mods 的验证结果留作参考（曾考虑的方向：Claude 用 mods 画在自己的窗格里）。
- mods 最小验证（2026-10-08，Claude Code 2.1.293，探针 mod 只观察、不改任何事件）：
  - `session.start` 在加载时触发（`surface: terminal`）；`session.end` 在 `/clear` 时 `reason: clear`，之后 `$.session.id()` 已是新会话；退出时 `reason: prompt_input_exit`。
  - `$.process.run` 能调用外部命令：`kitten --version`、`tmux display -p '#{pane_id}'`（得到自己的窗格）都成功。mod 也能开外部分屏。
  - `session.append`：对话每新增一行都经过它，`uuid` 与会话记录文件一致（13/13）；内容是精简版（`type`、`name`、`role`、`content`），没有时间戳、`parentUuid`、`toolUseResult`；多了来源（`door`：prompt、response、tool-result、attachment…）和产生者（`origin`）。
  - 等批准：调用那一行加入对话后约 30ms，`tool.check` 的结果是 `decision: "ask"`（带工具名和参数），紧接着 `classic.PermissionRequest` 也到达。
  - 提前显示：700 字的回答，`turn.step` 从第 9.4 秒起每约 50ms 一段送到，第 24.2 秒结束；这一行要到第 24.2 秒才加入对话。比会话记录早约 15 秒，比 MessageDisplay（约 0.5 秒一段）更细。一次短回答的全部正文在 40ms 内到达，原因未查。
  - 窗格：终端 ≥ 144 列时自动打开，是横跨整宽、位于对话和输入框之间的方框（不是侧栏）；几个窗格以标签页切换；等批准时，批准提示占用这块位置，窗格暂时不显示。
  - 共用核心能在 mod 里运行：解析 → 按轮视图 → 终端排版打包成 579 KB 的 ESM（`node:crypto`、`node:path` 换成替代件，`node:fs` 等不在这条路径上）。在 mod 里用 `$.fs.read` 读 245 KB 的会话记录，读取 1ms、解析加排版共 65ms，最新一轮画进窗格；颜色、粗体、暗淡都生效（暗淡显示为主题灰色）。空行被压掉，要改。
  - 要处理：`actions.ts` 用 TypeScript 编译器解析 Codex 代码调用（约 9 MB），验证时换成了桩；`createHash` 要换成纯 JS 的同步实现；mods 接口标注 EARLY ACCESS（可能随版本改变，不另行通知）。
- 仍待核实：VS Code 里 mods 窗格是否显示、能否代替 VS Code 版的 Claude 部分；Codex 等批准时 `thread/read` 是否带 `waitingOnApproval`；VS Code 里的 Claude Code 是否也写 `~/.claude/sessions/<pid>.json`。
- 实现（0.4.0）：hook 精简到只记录会话记录里没有或来得太晚的信息。Claude Code：`SessionStart`（两个插件）、`PermissionRequest`、`MessageDisplay`，从 8 个减到 4 个；Codex：`SessionStart`（两个插件）、`PermissionRequest`，从 7 个减到 3 个。去掉 `UserPromptSubmit`、`Stop`、`StopFailure`、`Interrupt`、`SessionEnd`：一轮的开始和结束看会话记录，会话结束看 Agent 进程；`activeAt` 加上会话记录最后写入的时间（VS Code 版靠它选当前会话）；提前显示的文字在会话记录出现同样的文字、或出现比它晚 1 秒以上的记录时丢弃。旧版文件里的 prompt、stop、end 照样折叠。
- 结果（2026-10-08，Claude Code 2.1.293、Codex 0.160.1 共用后台，tmux 3.6a；VS Code 宿主测试 14/14）：
  - Claude：提交后 1.7s 内显示「运行中」，4.1s 显示「等你批准」；批准后立即回到「运行中」，一轮结束约 2s 后「空闲」；500 字回答的正文在栏里比会话记录早约 10s 出现；`/clear` 改绑、退出关栏正常。状态文件里只有 start、approval（和 display）。
  - Codex：栏开在前台旁边，「运行中」来自会话记录，14.5s 显示「等你批准」（与 Codex 的批准提示同时）；批准后约 2s 回到「运行中」，结束后「空闲」；`/quit` 后栏关闭。Codex 要信任的 hook 从 7 个变成 3 个。
  - 端到端发现并修复：折叠时「空闲就丢掉显示文字」原本防止一轮结束后迟到的片段；去掉 prompt hook 后会话一直是空闲，所有提前显示的文字都会被丢掉 → 改为由会话记录判断何时丢弃。
- 审阅产物：`local/review/c2-5/` 下的栏文字记录（Claude 等批准、完成、长回答；Codex 等批准、完成）。

## C3 私有安装

- 内容：`npm run install:terminal`、`tickbird setup`（装 `tickbird-state` 与 `tickbird-split`，引导 Codex 信任 hook）；卸载时不误删 VS Code 版仍在用的 `tickbird-state`。
- 端到端：在你本机安装；新开 kitty 窗口启动 Claude Code，检查自动分屏；运行 `setup` 两遍，检查结果相同；卸载终端版，检查 `tickbird-state` 仍在。
- 审阅产物：安装输出和一张实际使用中的截图。
- 结果（2026-10-08，0.4.1）：
  - `npm run install:terminal`：打包 `~/.local/share/tickbird/cli.cjs`，命令 `~/.local/bin/tickbird`（先用 PATH 上的 node，没有就用安装时的 node）；VS Code 扩展 0.2.0 → 0.4.1 一起更新；`setup` 给 Claude Code 和 Codex 装上 `tickbird-state`、`tickbird-split`（0.4.1）。装插件的代码由 `install:vscode` 和 `setup` 共用（`packages/terminal/src/setup.ts`）。
  - `setup` 运行两遍：两个 Agent 里的插件和版本相同，没有重复安装。
  - 实际使用：tmux 里直接运行 `claude`（不加任何参数），自动开栏，栏里运行的是装好的 `cli.cjs`；一轮内容正常；`/exit` 后栏关闭。
  - `tickbird uninstall`：移除两个 Agent 里的 `tickbird-split`、命令和程序文件；VS Code 版还在，所以保留 `tickbird-state`。之后重新安装，VS Code 扩展已是同一版本，不再重装。
  - hook 的 PATH 可能来自别的程序（Codex 共用后台）：找不到 `tickbird` 时，退回到 `~/.local/bin/tickbird`。
  - kitty：用户运行 `setup` 并同意，kitty.conf 已备份并加上远程控制两行；完全重启 kitty 后，在 kitty 里启动 Claude Code 自动分屏，栏里运行的是装好的 `cli.cjs`（2026-10-08）。
  - 待用户完成：Codex 共用后台重启后（Codex 会提示），在 Hooks need review 里选 Trust all。
- 审阅产物：`local/review/c3/`（安装、卸载输出，tmux 里实际使用的栏）。
