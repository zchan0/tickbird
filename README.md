# Agent Sidecar — development build

VS Code 侧边栏里的只读过程观察器：读取当前项目的 Claude Code / Codex 本地会话记录，把 Agent 每一轮做了什么整理成章节，证据在编辑器区打开。原 Agent 负责对话和执行；Sidecar 不发送消息，也不执行记录里的任何命令。

状态：开发中，首轮 goal 尚未验收。进展与每批的验证记录见 [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md)，产品愿景与原则见 [VISION.md](./VISION.md)。

## 运行

需要 Node.js 22+、npm、本机 VS Code，以及当前项目已有的 Claude Code 或 Codex 会话记录。开发验证平台为 macOS，其他平台尚未实测。

```sh
npm ci --ignore-scripts
npm test
npm run dev
```

`npm run dev` 先构建，再用临时配置目录打开一个独立的 VS Code 开发窗口，加载本项目，以及本机已安装的 Codex（`openai.chatgpt`）和 Claude Code 扩展代码；不安装、不更新它们，也不复制账户凭据。目录位置会输出到终端。

改了代码后执行 `npm run build`，再在开发窗口执行 **Developer: Reload Window** 才会生效；Sidecar 里的「刷新」只重新读取会话，不重新加载代码。

也可以在本项目按 F5，选择 `Run Agent Sidecar Development Host`。

## 使用

1. 点活动栏的 Agent Sidecar 图标（或执行 `Agent Sidecar: Open Process Observer`），左侧主侧栏出现「过程」视图。它不占编辑器组，其它扩展打开文件也不会把它盖住。
2. 点顶部「切换会话」选择当前项目的会话。选单显示标题、来源、短 ID、更新时间和最近一句对话，可以搜索；只列当前项目的主会话，不混入子 Agent 日志。
3. 阅读：最新一轮在上，轮内按发生顺序排列。
   - **请求**：最多显示 6 行；「展开全文」在编辑器区打开完整请求，截图按原尺寸显示（带图的请求总有这个入口）。粘贴的内容会单独标出。
   - **Changed**：本轮写过的文件，点开看当时的修改。
   - **章节**：Agent 的话做标题，包括 Claude Code / Codex 在界面上显示的思考摘要；下面是它随后的调用，一次一行，左列是工具名（Bash、Read、Write、Chrome、Notion…），右侧是用途。只有出问题时才标结果：`exit 1`、`failed`、`rejected`、`denied`、`interrupted`、`no match`。
   - **向用户提问**（Ask）：在发生的位置成行，下面显示选中的答案（`✓ 私有 (Recommended)`）。
   - **结束的轮次**：整个过程收成一行，用 Agent 自己在一轮结束时的说法，比如 `✻ Crunched for 3m 12s · 42 calls ›`（Codex 为 `Worked for …`），点开是完整过程；请求、Changed 和最终回答留在外面。
   - 左侧细刻度对应各轮，悬停预览该轮的请求，点击跳转。
4. **详情**：点调用行或文件，在编辑器区打开。
   - 单文件读取（Claude 的 Read，或 `cat` / `head` / `tail` / `sed -n`）按文件显示：文件名、路径、行号范围、行号栏和语法高亮。
   - 写入显示当时的 diff；其它调用显示输入与返回。
   - 原始命令和来源位置折叠在底部。
   - 临时预览会被下一次打开复用；点「保留此页」后不再被覆盖。
5. **实时**：选定会话后自动读取新写入的记录。
   - 运行中的这一轮，时间线末尾有一个呼吸的圆点，后面是 Agent 同款的状态词和从本轮开始的计时，格式同 Agent（`1m 33s`）。Claude 会话取 Claude Code 的状态动词，Codex 会话显示 `Working`。还没返回的调用，右侧箭头在动。
   - 是否在运行：Claude Code 以它自己维护的 `~/.claude/sessions/<pid>.json`（busy / idle）为准，中断会立刻停下；Codex 以会话里的回合结束 / 中断事件为准。两者都取不到时，按记录是否仍在写入判断：10 分钟无新记录显示「无新记录」，6 小时以上不再显示运行状态。
   - 跟随：默认跟随最新一轮的末尾。向上滚动、点开记录会暂停；滚回末尾或点「回到最新」恢复；新一轮开始时自动恢复。正在跟随时，一轮结束会把最终回答滑到顶部。
   - 新内容逐项出现：先出 Agent 的话，再逐行出调用。
   - 延迟：Claude Code 会把调用前的思考和正文攒着，等调用参数生成完才一起写入，所以这部分可能比它自己的界面晚几秒到十几秒；Sidecar 自身每次更新只要几十毫秒。
6. 「覆盖记录」列出每条来源记录的去向：显示、合并、排除或待支持。

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
- `test:host`：在隔离的临时工作区打开真实 VS Code，检查侧边栏视图不占编辑器组、按活动列打开文件时不会盖住 Sidecar、详情预览的复用与保留、两种解析器的自动增量更新；再开一个没有文件夹的窗口，检查侧栏显示说明且不弹警告。Agent 对话由测试编辑器替代，不能据此说明与真实 Agent 扩展共存已验收。
- `audit:samples` / `verify:content` / `verify:sessions`：用本机固定的真实会话核对来源覆盖、正文字节和回合分组；只输出元数据、长度和哈希，不写出正文。
- `test:coexistence`：打开真实 Codex / Claude Code 扩展做共存检查。**断言仍是旧的编辑器组布局，尚未按侧边栏形态更新。**
- 生成的报告在 `.test-artifacts/`，不进入版本控制。

## 实现边界

- 只读：不执行记录中的工具和命令，不打开记录里的链接，也不读取当前文件、图片路径来冒充历史证据。详情里显示的都是会话当时记录的内容。
- 系统 / 开发者指令、隐藏推理、技能与运行时注入不显示；思考只显示 harness 自己在界面上展示的摘要，签名与加密内容不读取。
- 仅普通本地单文件夹工作区。空窗口、多文件夹和远程工作区里，侧栏直接说明原因（空窗口带「打开文件夹…」），不弹警告。会话按项目目录匹配；没有明确回合归属的记录单列，不猜归属。
- 会话选择器只为较新的会话预读标题和最近一句（单个文件 64 MiB 以内）；观察时逐段读取，单条记录超过 16 MiB 时不展示正文。
- 未完成：真实 Agent 扩展共存验收、跳转回原聊天位置、Bash 单行信息量、流程图。

## 代码

- `packages/core/src/`：数据模型、Claude / Codex 解析器（`claude.ts`、`codex.ts`）、章节模型（`chapters.ts`）、增量读取与实时会话（`record-stream.ts`、`live-session.ts`）、Agent 运行状态（`agent-status.ts`）、调用归纳与证据呈现（`actions.ts`、`tool-view.ts`、`presentation.ts`）。
- `packages/vscode/src/`：扩展宿主（`extension.ts`）、渲染（`render.ts`、`chapter-view.ts`、`markdown.ts`、`code.ts`）、页面脚本（`live-client.ts`、`follow-client.ts`、`inline-client.ts`）。
- `tests/`、`scripts/`：可重跑的测试、宿主验证与真实样本核对。

Webview 的 CSP 与消息边界依据 [VS Code 官方 Webview 文档](https://code.visualstudio.com/api/extension-guides/webview)。不依赖其他 Agent 的私有状态或 UI DOM；读取的只有它们写在本机的会话记录，以及 Claude Code 公开写出的运行状态文件。

已过期的方案、评审和核对记录归档在本地的 `archived/`（不进入版本控制），设计探针在 `probes/`。
