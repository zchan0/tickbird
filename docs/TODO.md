# 待办

2026-10-10 整理。P0 先做，P1 随后，P2 等前面定了再做。每项做完写结果，删掉或移进对应的计划文档。

## P0

### 1. 工具摘要提取得没有意义（core，两个版本共用）

`packages/core/src/tool-view.ts` 的 `toolView()`。真实会话里的例子：

| 现在显示 | 原始调用 | 问题 |
| --- | --- | --- |
| `Bash  cd ~/.claude/projects/-Users-me-Dev…` | `cd … && ls -lt *.jsonl \| head -8` | `cd` 占满整行，真正的命令被截掉 |
| `Bash  grep -n -i "重新设计\|redesign\|…" docs/TERMINAL_PLAN.md \| he` | 原样 grep | 没有拆解，原样截断 |
| `Bash  查看改动；查看改动 · docs/TERMINAL_PLAN.md；取前 200 行` | `git diff --stat && git diff … \| head -200` | 重复；`head` 这类管道尾巴是噪音 |
| `Bash  读取 split.log；查看目录 · sessions；读取` | `tail …; ls …; cat …` | 末尾 `读取` 没有对象 |
| `Bash  运行 python3 脚本` | `python3 - <<'EOF' …` | 看不出脚本做什么（可取脚本里打开的文件） |
| `Read  outline.ts` | `sed -n 85,135p …` | 丢了行范围 |
| `Write codex.ts` | `Edit` | Edit 和 Write 合成一个名字，看不出是改还是新建 |
| `Artifact 参数 · action、intent、design_systems` | 未识别的工具 | 只列参数名 |

方向：

- 先跳过 `cd`、`export`、`source`、环境变量赋值，摘要从第一个有意义的命令开始。
- 丢掉管道尾部的 `head`、`tail`、`wc`、`sort`、`grep -v`。
- 同一动作合并（`查看改动 ×2`），动作没有对象时不写。
- 识别不了时显示命令本身的前几个词，不硬套中文动词。
- Read 保留行范围（`outline.ts:85–135`）；Edit 和 Write 分开。
- 未知工具：取第一个短字符串参数的值，不列参数名。

做法：写一个脚本，跑本机最近 20 个 Claude 和 Codex 会话，输出「现在 / 改后 / 原始」三列对照表，先审对照表，再改代码。

进展（2026-10-10，未提交，待审对照表）：命令解析移到 `packages/core/src/command-line.ts`，终端改用它。2340 个调用行里 1000 多行有变化。已定（与用户确认）：只读的命令两边都显示成 Read / Search / List（Codex 记录里的 `parsed_cmd` 就是这么分的）；脚本只标改动（`python3 · edits x.ts`）。还没做：Codex 网页调用里的 `turn1view2` 这类引用，要从之前的结果里查出网址（7 行）。

### 2. Sidecar 比 Agent 晚出内容，而且思考和工具一起出现（先测量）

Sidecar 这边不慢：会话记录一有写入，30ms 内就读（`fs.watch`），最慢 500ms 一次轮询（`packages/core/src/live-session.ts`）。所以延迟多半在 Claude Code 写会话记录的时机：思考和工具调用属于同一条消息，可能整条消息写完才落盘，甚至工具开始后才落盘。

- 先测量：在测试 kitty 里跑一个会运行几秒的 Bash，记录 Agent 屏幕出现调用的时间、会话记录写入的时间、Sidecar 画出的时间。Codex 也测一次。
- 如果确实是会话记录晚：考虑订阅 `PreToolUse`（`async: true`，不拖慢 Agent），把「将要运行的调用」提前写进会话状态，和 `MessageDisplay` 的提前显示同一套处理。这会改 [SESSION_STATE.md](./SESSION_STATE.md) 的「只订阅三种 hook」，要先确认。
- 测量结果决定第 5 项动效怎么做，所以放在 P0。

### 3. 去掉打开链接后的绿色提示条

`packages/terminal/src/watch.ts` 的 `say()`：打开图片、链接、文件成功后显示 4 秒。成功时不再显示，「已复制」也去掉（已确认）。打开失败、不能复制时仍然显示，否则看不出失败。

### 4. 新建的文件标成了 M（core）

本轮用 Write 新建了 `docs/TODO.md`，「改动」里显示 `M TODO.md`，应为 `A`。`packages/core/src/chapters.ts` 的 `changedFiles()` 只认补丁里的 `operation === 'add'`；Claude 的 Write 要看 `toolUseResult.type`（`create` / `update`）。

另外，用 Bash 改的文件（例如本轮用 python 改的 `STATUS.md`）不在「改动」里。这是已知限制，不在这一项里解决。

## P1

### 5. 工具行的出现动效和运行中标记

依赖第 2 项的测量结果。

- 新到的内容依次出现：文字逐段出现，工具一行一行出现；一批的总时长设上限（例如 300ms），不能让 Sidecar 比实际更慢。
- 运行中的调用：在树杈那一格（`├` / `└` 的位置）放一个单格动画（例如 braille 旋转），不改排版。运行完换回 `├` / `└`，再把下面的 `│` 接上。
- 只给新到的内容做动效；翻回旧的一轮、重画、改窗口宽度时不播放。
- 先出设计稿（动效用 HTML 模拟），确认后再开发。

### 6. Final Answer 展开后自动滚到顶

建议做，但加两个条件：

- 展开后放不下才滚动：把 Final Answer 这一行滚到正文顶部。放得下就不动。
- 收起时不跳：保持 Final Answer 这一行在原来的屏幕位置。
- 跟随模式下展开，等于暂停跟随，直到滚回底部。

### 7. 一轮结束时不再跳回开头

现在跟随中的一轮结束时，页面滚回这一轮的开头（`packages/terminal/src/app.ts` 的 `update()`：`state.wasLive` 时 `scroll = 0`）。当初的理由是「答复在 Agent 的窗格里」。现在页面末尾有 Final Answer，跳回开头反而把结果移出了屏幕。

改为：结束时留在末尾，Final Answer 和改动结算都在屏幕上。

### 8. 「改动」改成一轮的结算

现在「改动  M TODO.md」紧贴在 Prompt 下面，看起来像提问的一部分，也不像结算。

建议（先出设计稿）：

- 移到这一轮末尾、Final Answer 后面，用和 `Prompt` / `Final Answer` 同样的标签（例如 `Changes`）。
- 一个文件一行：`A TODO.md  +80`，标记用颜色区分，带改动行数，点开看 diff。
- 运行中不显示，一轮结束后出现。

## P2

### 9. Session title 显示（待讨论）

core 已经能取会话标题（`packages/core/src/session-title.ts`，Claude 的 `ai-title`）。候选位置是顶栏：标题放左边，`第 1 轮 / 共 1 轮` 缩成 `1/1`，放不下时截断标题。48 列很窄，要先出设计稿比较。

### 10. VS Code 面板按终端 v4 的设计更新

终端 v4 已定的结论搬到 VS Code webview：树杈排法、Claude Code 式 diff、统一灰色的调用内容、`Prompt` / `Final Answer` / `New turn` 标签、Final Answer 折叠、点开调用直接打开对象。

放在 P2 的原因：第 1、4 项（core）两个版本共用，第 5–9 项还在改终端的交互。等这些定了一次搬过去，避免改两遍。先出 VS Code 版设计稿，再开发。

## 不做

- 收起 Prompt：讨论后决定不收起（2026-10-10）。
