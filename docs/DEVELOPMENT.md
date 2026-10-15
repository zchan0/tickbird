# 开发

```sh
npm ci --ignore-scripts
npm test
npm run dev
```

`npm run dev` 先构建，再用临时配置目录打开一个独立的 VS Code 开发窗口，加载本项目，以及本机已安装的 Codex（`openai.chatgpt`）和 Claude Code 扩展代码；不安装、不更新它们，也不复制账户凭据。目录位置会输出到终端。

改了代码后执行 `npm run build`，再在开发窗口执行 **Developer: Reload Window** 才会生效；Tickbird 里的「刷新」只重新读取会话，不重新加载代码。

也可以在本项目按 F5，选择 `Run Tickbird Development Host`。在 worktree 里开发时，用 `npm run dev -- <项目目录>` 打开有会话的项目。

从源码安装（开发用）：`npm run install:all` 把终端版、VS Code 版和两个插件从这个仓库装上（插件市场登记为本地目录，插件原地加载，改了新开会话就生效）；之后有开发安装的 `tickbird` 时，分屏优先用它，而不是插件里打包好的程序。也可以分开装：`npm run install:vscode`、`npm run install:terminal`；终端版用 `tickbird uninstall` 卸载。

`npm run package:vscode`、`npm run package:terminal` 只打包，不安装。产品和接入用同一个版本号，用 `npm run set-version -- x.y.z` 修改，它同时重新打包 `plugins/tickbird-split/program/tickbird.cjs`（插件自带的程序）；改了 `plugins/` 下的插件后必须升版本，Agent 才会取更新，见 [plugins/tickbird-state/README.md](../plugins/tickbird-state/README.md)。

GitHub Actions：每次推送到 `main` 和每个 PR 在 macOS、Linux（Node 22、24）上跑 `npm test` 并打包；推送标签 `v<版本>`（与 `package.json` 一致）时发布 GitHub Release，附带 `.vsix` 和终端版程序，发布说明取自 [CHANGELOG.md](../CHANGELOG.md) 里这一版的一节。

改动随提交记在 [CHANGELOG.md](../CHANGELOG.md) 的「未发布」下面，只写使用者看得到的变化。

发版：`npm run release -- x.y.z`（或 `patch`、`minor`、`major`，在上一版的基础上加一）。它检查在 `main` 上、没有未提交的改动、「未发布」下面有内容，然后把「未发布」改成这一版的版本号和日期、改版本号、跑测试、提交、推送、等 CI 通过、打标签、等发布完成，最后装到本机。哪一步失败就停在哪一步并说明原因；修好后再运行同一条命令，已经完成的步骤会跳过。真实 VS Code 的核对（`npm run test:host`）需要桌面环境，只在本机跑。

## 演示动图

README 里的动图和 VS Code 截图由脚本生成：

```sh
npm run record-demo
```

演示会话是构造的（[demo/session.mjs](../demo/session.mjs)），不是录下来的。脚本把它按时间回放进终端版自己的渲染和动效，每秒 10 帧，左边按 Claude Code 的样子画出 Agent 那一栏；再用无头 Chrome 截图、ffmpeg 合成 GIF，写到 `docs/images/`。界面改了以后重跑一次就能更新。需要 Google Chrome 和 ffmpeg。

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
- `plugins/tickbird-state/`、`packages/core/src/session-state.ts`：给 Claude Code 和 Codex 的会话状态插件，及其读取，格式见 [SESSION_STATE.md](./SESSION_STATE.md)。
- `packages/vscode/src/`：扩展宿主（`extension.ts`）、渲染（`render.ts`、`chapter-view.ts`、`markdown.ts`、`code.ts`）、页面脚本（`live-client.ts`、`follow-client.ts`、`inline-client.ts`）。
- `tests/`、`scripts/`：可重跑的测试、宿主验证与真实样本核对。

Webview 的 CSP 与消息边界依据 [VS Code 官方 Webview 文档](https://code.visualstudio.com/api/extension-guides/webview)。不依赖其他 Agent 的私有状态或 UI DOM；读取的只有它们写在本机的会话记录，以及 Claude Code 公开写出的运行状态文件。

## 文档

- 进仓库、可共享：`README.md`、`docs/`、各插件目录下的 README。不写本机路径、真实会话 ID 或会话内容。
- 只在本地、不提交：`local/`（开发日志 `DEVELOPMENT_LOG.md`、已过期的方案 `archived/`）、`probes/`（设计探针，含真实会话内容）、`.codex/`（早期原型）。
