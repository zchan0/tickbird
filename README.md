# Tickbird — development build

VS Code 侧边栏里的只读过程观察器：读取当前项目的 Claude Code / Codex 本地会话记录，把 Agent 每一轮做了什么整理成章节，证据在编辑器区打开。原 Agent 负责对话和执行；Tickbird 不发送消息，也不执行记录里的任何命令。

状态：0.7.0，开发中。现状、已知问题与待办见 [docs/STATUS.md](./docs/STATUS.md)，产品愿景与原则见 [docs/VISION.md](./docs/VISION.md)，终端版设计见 [docs/TERMINAL_DESIGN.md](./docs/TERMINAL_DESIGN.md)。

## 安装

Tickbird 有两个版本，装哪个都行，也可以都装：终端版在 Agent 旁边开一栏，VS Code 版在侧边栏。两者都通过 Agent 自己的插件取得会话状态。

需要 Node.js 22 以上（插件的 hook 用 `node` 运行），以及要接入的 Agent：Claude Code、Codex，有一个就行。

### 终端版

在 Claude Code 里：

```
/plugin install tickbird-split --marketplace zchan0/tickbird
```

`tickbird-split` 自带 Tickbird 程序，依赖的 `tickbird-state` 会一起装上。（Claude Code 2.1.275 以前的版本分两步：`/plugin marketplace add zchan0/tickbird`，再 `/plugin install tickbird-split@tickbird`。）

在 Codex 里：

```sh
codex plugin marketplace add zchan0/tickbird
codex plugin add tickbird-state@tickbird
codex plugin add tickbird-split@tickbird
```

Codex 第一次启动会提示 **Hooks need review**，选 Trust all（或执行 `/hooks`，按 `t`）。不信任时 Codex 静默跳过这些 hook。

之后新开的 Agent 会话旁边会自动开一栏，已经开着的会话不受影响。各终端的情况：

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

### VS Code 版

从 [GitHub Releases](https://github.com/zchan0/tickbird/releases) 下载 `tickbird-<版本>.vsix`：

```sh
code --install-extension tickbird-<版本>.vsix
```

再给 Agent 装上 `tickbird-state`（装了终端版就已经有了）：Claude Code 里 `/plugin install tickbird-state --marketplace zchan0/tickbird`；Codex 里同上面的 `marketplace add` 和 `plugin add tickbird-state@tickbird`。没有它，侧栏仍能手动选择会话，但不会自动跟随本窗口的会话，也不显示 Needs approval。

### 更新与卸载

- 插件：在 Agent 的插件管理里更新或卸载（Claude Code 的 `/plugin`，Codex 的 `/plugins`）。两个 Agent 都只在插件版本号变化时取更新。
- VS Code 版：装新的 `.vsix`；卸载在扩展面板里。

插件做什么：`tickbird-state` 是一组只写会话状态的 hook（会话属于哪个窗口、是否在等你批准、屏幕上正在显示的长回答），写到本机文件；不显示界面，不改变 Agent 的行为。`tickbird-split` 在会话开始时开一栏，运行 Tickbird 只读地显示这个会话。

## 开发

```sh
npm ci --ignore-scripts
npm test
npm run dev
```

`npm run dev` 先构建，再用临时配置目录打开一个独立的 VS Code 开发窗口，加载本项目，以及本机已安装的 Codex（`openai.chatgpt`）和 Claude Code 扩展代码；不安装、不更新它们，也不复制账户凭据。目录位置会输出到终端。

改了代码后执行 `npm run build`，再在开发窗口执行 **Developer: Reload Window** 才会生效；Tickbird 里的「刷新」只重新读取会话，不重新加载代码。

也可以在本项目按 F5，选择 `Run Tickbird Development Host`。在 worktree 里开发时，用 `npm run dev -- <项目目录>` 打开有会话的项目。

从源码安装（开发用）：`npm run install:all` 把终端版、VS Code 版和两个插件从这个仓库装上（插件市场登记为本地目录，插件原地加载，改了新开会话就生效）；之后有开发安装的 `tickbird` 时，分屏优先用它，而不是插件里打包好的程序。也可以分开装：`npm run install:vscode`、`npm run install:terminal`；终端版用 `tickbird uninstall` 卸载。

`npm run package:vscode`、`npm run package:terminal` 只打包，不安装。产品和接入用同一个版本号，用 `npm run set-version -- x.y.z` 修改，它同时重新打包 `plugins/tickbird-split/program/tickbird.cjs`（插件自带的程序）；改了 `plugins/` 下的插件后必须升版本，Agent 才会取更新，见 [plugins/tickbird-state/README.md](./plugins/tickbird-state/README.md)。

GitHub Actions：每次推送到 `main` 和每个 PR 在 macOS、Linux（Node 22、24）上跑 `npm test` 并打包；推送标签 `v<版本>`（与 `package.json` 一致）时发布 GitHub Release，附带 `.vsix` 和终端版程序。真实 VS Code 的核对（`npm run test:host`）需要桌面环境，只在本机跑。

## 使用

VS Code 版和终端版是同一套排法：一页一轮，调用挂在工具名下面的树杈上，一轮结束后 Final Answer 和改动各收成一行放在末尾。

### VS Code 版

1. 点活动栏的 Tickbird 图标（或执行 `Tickbird: Open Process Observer`），左侧主侧栏出现视图。它不占编辑器组，其它扩展打开文件也不会把它盖住。
2. 视图标题栏：切换会话、刷新，`…` 里是覆盖记录；标题后面是会话名（只用 Agent 保存的名字）。切换会话的选单显示标题、来源、短 ID、更新时间和最近一句对话，可以搜索；只列当前项目的主会话。
3. 一页一轮。顶栏写「第 n 轮 / 共 N 轮 · 开始时间」，‹ › 或 `[` `]` 翻到上一轮、下一轮，☰ 或 `t` 打开目录（每轮一项，写着它的请求）。
4. 一轮从上到下：
   - **Prompt**：你的请求，左边一条蓝线。一轮中途发的消息也这样标。
   - **Agent 调用**（subagent）不在调用带上，单独成块：工具名一行（几个描述有共同前缀时，前缀写在这一行，如 `Agent · Name brainstorm`）；每个 subagent 一个圆点，颜色就是状态（黄 运行中、绿 完成、红 失败、灰 已停止），后面是它的描述，正文色；下面一行灰字写它的情况：后台、用时、tokens、调用次数（tokens 和完成时的调用次数来自结束通知，运行中显示已用时间和已做的调用）。
   - **Agent 的话**，下面是它随后的调用，放在一条底色带上：工具名（Bash、Read、Edit、Search…）单独一行，调用用树杈挂在下面，同一工具连续调用只写一次名字。调用内容统一灰色；颜色只给失败（红，`exit 1`、`rejected` 等）、改动行数（绿 / 红）和运行中（暗金）。命令写的是 Agent 给它的说明，或从命令本身读出来的动作；命令改了文件时，后面接着写改了哪些文件。
   - **向用户提问**（Ask）在发生的位置成行，下面是选中的答案。
   - **Final Answer**：一轮结束后收成一行，点开看全文；放不下时把它滚到顶部。
   - **Changes**：本轮改过的文件数和总行数，点开每个文件一行。脚本改的文件也算进来，没有行数。
5. **点开一条调用**，打开它指向的东西：
   - Read（含 `cat`、`sed -n` 这类只读命令）：在编辑器里打开文件，选中当时读的那几行。文件改过、那几行挪了位置时选中新位置；那几行已经不在了，就打开当时的记录。
   - 读的图片、本地文件、网址：用 VS Code 或浏览器打开。
   - Edit / Write，以及 Changes 里的文件：在编辑器区打开 diff，带记录里的行号，改动的词用更亮的颜色标出（Claude Code 的配色）。同一文件在这一轮改过几次时，用 ‹ › 或 `<` `>` 切换。
   - Agent（Claude Code 的 subagent）：子任务自己留了记录时，打开它的那一轮：交给它的任务放在 Prompt 的位置（终端版折叠成前 3 行，⏎ 或点击展开、再按收起，`y` 复制全文），下面是它的话和调用，Final Answer 展开。子任务还在跑时跟着它的记录更新，末尾转圈。几个 subagent 之间用 `[` `]`（终端版）切换，或在面板里点另一行（VS Code 版，「保留此页」可以并排看）。Codex 的子任务暂不支持。
   - 其它调用：打开详情页，标题是面板里那一行的说法，下面是输入和返回。
   - 详情页会被下一次打开复用；点「保留此页」后不再被覆盖。
6. **实时**：选定会话后自动读取新写入的记录。
   - 一轮在运行时，页面末尾一行在转圈，不论是调用在跑还是 Agent 在想下一步；调用行本身不转圈。10 分钟没有新记录时显示「无新记录」。
   - 后台任务（后台运行的 Agent、Bash）：一轮结束后还有任务没返回时，末尾灰字写「N background tasks running」，只在 Agent 还报告状态时显示。任务返回后，通知在这一轮里成为一行，Agent 接着说的话成为新的 Final Answer，之前的回答回到过程里。
   - 新内容依次出现：先出 Agent 的话，话出完再出它下面的调用。
   - 跟随：默认跟随最新一轮的末尾，一轮结束后停在末尾。向上滚动、点开调用或翻到旧的一轮会暂停，顶栏出现「↓ 跟随」，点它回到最新一轮。看旧的一轮时开始了新的一轮，底部提示 **New turn**。
   - 是否在运行：Claude Code 以它自己维护的 `~/.claude/sessions/<pid>.json`（busy / idle）为准；Codex 以会话里的回合结束 / 中断事件为准。
   - **装了 `tickbird-state` 时**（`npm run install:vscode` 会装上）：自动跟随本窗口最近活跃的会话；Agent 停下等你批准时，末尾显示 **Needs approval** 和要批准的工具、文件；Claude Code 的话在写进会话记录之前就先显示出来。手动选了别的会话就暂停跟随，提示条里可以恢复。
7. 「覆盖记录」列出每条来源记录的去向：显示、合并、排除或待支持。

### 终端版

在 kitty 或 tmux 里新开 Claude Code 或 Codex 会话，旁边自动开一栏（约 48 列）。内容和排法同 VS Code 版。按 `?` 看全部按键，常用的：

| 按键 | 作用 |
| --- | --- |
| `j` `k` / `↓` `↑` | 选择调用或答复（选中后暂停跟随） |
| `⏎` | 打开详情；展开或收起 Final Answer、Changes |
| `[` `]` | 上一轮 / 下一轮；详情里是上一条 / 下一条调用 |
| `<` `>` | 详情里：同一文件的上一次 / 下一次修改 |
| `g` `G` | 开头 / 末尾（`G` 回到最新一轮并恢复跟随） |
| `t` `o` `y` | 目录 / 在编辑器打开 / 复制 |
| `a` `q` | 切回 Agent / 退出 |

## 验证

```sh
npm run check            # 类型检查
npm test                 # 单元测试
npm run test:realtime    # 增量读取与实时会话
npm run test:host        # 真实 VS Code 宿主
npm run audit:samples
npm run verify:content
npm run verify:sessions
npm run test:coexistence
```

- `test`：解析器、章节模型、渲染安全、页面脚本（jsdom）等。用的都是合成 fixture，不执行 fixture 中的命令。
- `test:realtime`：记录切分、增量读取、会话发现与选择器。
- `test:host`：在隔离的临时工作区打开真实 VS Code，检查侧边栏视图不占编辑器组、按活动列打开文件时不会盖住 Tickbird、详情预览的复用与保留、两种解析器的自动增量更新；再开一个没有文件夹的窗口，检查侧栏显示说明且不弹警告。Agent 对话由测试编辑器替代。
- `audit:samples` / `verify:content` / `verify:sessions`：用本机固定的真实会话核对来源覆盖、正文字节和回合分组；只输出元数据、长度和哈希，不写出正文。
- `test:coexistence`：加载本机已装的最新 Codex / Claude Code 扩展，用它们的公开命令打开各自的面板，再打开 Tickbird、点开详情、保留此页，检查 Agent 的标签页始终在原来的组里、没有被替换。样本是本项目每家 Agent 最近的、有足够调用的两个会话。不检查 Agent 面板里的内容。
- 生成的报告在 `.test-artifacts/`，不进入版本控制。

## 实现边界

- 只读：不执行记录中的工具和命令。详情页和 diff 显示的都是会话当时记录的内容。点开 Read、图片和链接时打开的是它们本身：Read 先核对当时读到的那几行仍在文件里，不在就打开当时的记录；网址只在你点开时交给浏览器。
- 系统 / 开发者指令、隐藏推理、技能与运行时注入不显示；思考只显示 harness 自己在界面上展示的摘要，签名与加密内容不读取。
- 仅普通本地单文件夹工作区。空窗口、多文件夹和远程工作区里，侧栏直接说明原因（空窗口带「打开文件夹…」），不弹警告。会话按项目目录匹配；没有明确回合归属的记录单列，不猜归属。
- 会话选择器只为较新的会话预读标题和最近一句（单个文件 64 MiB 以内）；观察时逐段读取，单条记录超过 16 MiB 时不展示正文。
- 未完成：跳转回原聊天位置；脚本改的文件没有行数；Codex 的补丁没有行号。

## 代码

- `packages/core/src/`：数据模型、Claude / Codex 解析器（`claude.ts`、`codex.ts`）、章节模型（`chapters.ts`）、增量读取与实时会话（`record-stream.ts`、`live-session.ts`）、Agent 运行状态（`agent-status.ts`）、调用归纳与证据呈现（`actions.ts`、`tool-view.ts`、`presentation.ts`、`command-line.ts`）。两个版本共用的调用一行（`call-line.ts`）和点开调用时打开什么（`call-target.ts`）也在这里。
- `packages/terminal/src/`：终端版（`app.ts` 状态与按键，`views/` 各页面，`watch.ts` 读取与重画）。
- `plugins/tickbird-state/`、`packages/core/src/session-state.ts`：给 Claude Code 和 Codex 的会话状态插件，及其读取，格式见 [docs/SESSION_STATE.md](./docs/SESSION_STATE.md)。
- `packages/vscode/src/`：扩展宿主（`extension.ts`）、渲染（`render.ts`、`chapter-view.ts`、`markdown.ts`、`code.ts`）、页面脚本（`live-client.ts`、`follow-client.ts`、`inline-client.ts`）。
- `tests/`、`scripts/`：可重跑的测试、宿主验证与真实样本核对。

Webview 的 CSP 与消息边界依据 [VS Code 官方 Webview 文档](https://code.visualstudio.com/api/extension-guides/webview)。不依赖其他 Agent 的私有状态或 UI DOM；读取的只有它们写在本机的会话记录，以及 Claude Code 公开写出的运行状态文件。

## 文档

- 进仓库、可共享：`README.md`、`docs/`、各插件目录下的 README。不写本机路径、真实会话 ID 或会话内容。
- 只在本地、不提交：`local/`（开发日志 `DEVELOPMENT_LOG.md`、已过期的方案 `archived/`）、`probes/`（设计探针，含真实会话内容）、`.codex/`（早期原型）。
