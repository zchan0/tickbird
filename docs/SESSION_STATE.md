# 会话状态（接入 → 显示端）

状态：已确认（2026-10-05）；2026-10-08 精简为三种事件（见「记录」）；2026-10-11 加 `call`（Claude Code 的 `PreToolUse`）。实现：插件 `sidecar-state`（`plugins/sidecar-state/`，hook 与两份插件清单）、`packages/core/src/session-state.ts`（读取与折叠）。

接入是给 Claude Code 和 Codex 的一组 hook。它只做一件事：把「当前有哪些会话、各自在做什么」写到本机。VS Code 版和终端版读这些文件，决定跟随哪个会话、显示什么状态。接入不显示任何东西，也不改变 Agent 的任何行为。

会话记录（transcript）仍是内容的唯一来源。会话状态只补会话记录里没有、或来得太晚的四样东西：

1. 这个会话属于哪个窗口（VS Code 窗口或 kitty 窗口）。
2. Agent 是否正在等你批准。
3. 正在显示、但还没写进会话记录的长回答。
4. 已经显示为正在运行、但还没写进会话记录的调用（只有 Claude Code：实测它有时在调用开始运行几秒后才写进会话记录，见 [TODO.md](./TODO.md) 第 2 项）。

## 位置

```
$XDG_STATE_HOME/agent-sidecar/sessions/     默认 ~/.local/state/agent-sidecar/sessions/
  claude-<session_id>.jsonl
  codex-<session_id>.jsonl
```

- 一个会话一个文件。目录权限 0700，文件 0600。
- 文件只追加，不改写。每次 hook 追加一行。并发的 hook（例如每 0.5 秒一段的 `MessageDisplay`）不用加锁。
- 显示端读文件时，从头折叠成当前状态。
- 只订阅四种 hook：`SessionStart`、`PermissionRequest`，以及只有 Claude Code 订阅的 `MessageDisplay`、`PreToolUse`。一轮的开始和结束看会话记录（Claude 的用户消息和 `turn_duration`，Codex 的 `task_started`、`task_complete`、`turn_aborted`），会话结束看 Agent 进程是否还在。
- Claude Code 里除 `SessionStart` 外的 hook 都在后台执行（`async: true`），不拖慢 Agent。后台执行时写入的先后可能和发生的先后不一致，所以折叠时按每行的 `t` 排序，流式文字按 `index` 拼接。
- 不订阅 `PostToolUse`：每次工具调用都多一次同步 hook，代价太大。等批准什么时候结束，看会话记录（见下）。

## 记录

第一行是 `start`，写会话的固定信息；之后每行是一个事件。

```jsonc
{"v":1,"t":1791164847514,"e":"start","provider":"claude","session":"<session-id>",
 "transcript":"/Users/…/<session-id>.jsonl","cwd":"/Users/…/project",
 "agentPid":68970,"hostPid":61907,"source":"startup",          // Codex 共用后台时还有 "serverPid"
 "kitty":{"window":"19","socket":"unix:/…/kitty-1604"}}      // 只在 kitty 里
{"v":1,"t":…,"e":"approval","tool":"Write","summary":"numbers.txt"}   // PermissionRequest
{"v":1,"t":…,"e":"display","message":"56bd…","index":3,"final":false,"text":"…"}  // MessageDisplay
{"v":1,"t":…,"e":"call","tool":"Bash","input":{"command":"npm test","description":"Run the tests"}}  // PreToolUse
```

0.2 和 0.3 版的 hook 还写过 `prompt`（UserPromptSubmit）、`stop`（Stop、StopFailure、Codex Interrupt）、`end`（SessionEnd）。旧文件里的这些行照样折叠，但显示端不再依赖它们。

- `agentPid`：显示这个会话的进程（会话的"前台"），它退出就是会话结束。通常是 hook 的 `$PPID`：claude 进程，或 Codex app-server（VS Code、embedded 模式）。Codex 0.157 起默认用共用后台运行所有终端的会话，`$PPID` 是后台；这时记录终端里的 `codex` 前台（找法见 [TERMINAL_DESIGN.md](./TERMINAL_DESIGN.md) 第 9 节），`kitty` 也取自前台的环境变量。找不到或分不清时仍记录后台。
- `serverPid`：只在上面的情况出现，是 Codex 共用后台的进程号，仅供排查。
- `hostPid`：`agentPid` 的父进程。在 VS Code 里是所在窗口的扩展宿主；在终端里是 shell，不用于匹配。
- `summary`：工具参数的一行摘要，最多 200 字符。不写完整参数。
- `input`：只留画调用行要用的几个短字段（命令、description、路径、搜索模式、网址等），每个压成一行、最多 200 字符；其它参数（文件内容、补丁、嵌套对象）一律不写。
- `display` 只记录 Agent 已经显示在屏幕上的文字，和稍后写进会话记录的内容相同。

## 折叠后的状态

```ts
interface SessionState {
  provider: 'claude' | 'codex'; session: string; transcript?: string; cwd: string;
  agentPid: number; hostPid: number; kitty?: { window: string; socket: string };   // serverPid 不折叠
  startedAt: number; activeAt: number;            // 最近一次事件，或会话记录最后写入的时间，取较晚的
  phase: 'idle' | 'working' | 'waiting' | 'ended';
  approval?: { tool: string; summary: string; at: number };   // waiting 时才有
  draft?: { message: string; text: string; at: number };      // 正在显示的长回答
  calls?: { tool: string; input: Record<string, string>; at: number }[];  // 已显示、可能还没写进会话记录的调用
}
```

| 事件 | phase | 其它 |
| --- | --- | --- |
| start | idle | |
| approval | waiting | 设置 approval |
| display | 不变 | 同一 message 的 text 依次拼接；message 变了就重新开始。不结束等批准 |
| call | 不变 | 加入 calls，只留最近 8 个 |
| prompt（旧文件） | working | 清空 approval、draft |
| stop（旧文件） | idle | 清空 approval、draft |
| end（旧文件） | ended | |

`phase` 只说明是否在等批准、是否已结束。「工作中 / 空闲」由显示端从会话记录判断。

Agent 进程（`agentPid`）已经不在时，不论最后一个事件是什么，都按 ended 处理。

两个 Agent 都不通知「批准已处理」。会话记录里出现批准之后的任何新记录（调用结果或拒绝），就说明已处理。显示「等你批准」要用 `awaitingApproval(state, 会话记录最后时间)`，不能只看 `phase`。

## 显示端怎么用

- **VS Code 版**：取 `hostPid` 等于本扩展 `process.pid`、且未结束的会话，跟随 `activeAt` 最新的那个。`activeAt` 包含会话记录最后写入的时间，所以正在工作的会话会排在前面。一个都没有时，回到现在的会话选择器。
- **终端版**：栏按 `agentPid` 绑定，显示这个进程最近活动、未结束的会话；`/clear`、`/resume`（Codex 的 `/new`）在同一进程里产生新的 `start`，栏随之改绑；进程消失时栏退出。会话记录按 `transcript` 打开，所以自定义的 `CODEX_HOME` 也能用。
- **calls**：会话记录最新一轮里出现同一工具、同一命令（或文件、模式、网址）的调用后丢弃，有几个就抵消几个；30 秒还没出现也丢弃（`pendingCalls(state, 最新一轮的调用, 现在)`）。
- **draft**：会话记录里出现同一段回答后，或会话记录里出现比 draft 最后一段晚 1 秒以上的记录（轮被中断、下一轮已开始）时，丢弃 draft（`pendingDraft(state, 正文, 会话记录最后时间)`）。

## 清理

`start` 时顺带删除 7 天前的文件，但只删 Agent 进程已不在的会话。

## 启用与停用

- 装上接入就是启用。停用用 Agent 自己的插件管理：Claude Code 用 `/plugin`，Codex 用 `/plugins`。用户在 Agent 里能看到它、关掉它。
- Codex 的 hook 必须先在 `/hooks` 里信任一次，否则会被静默跳过。安装流程要引导这一步，显示端检测到「Codex 会话没有状态文件」时也要提示。

## 约束

- hook 必须静默：SessionStart 的 stdout 会进入模型上下文。
- hook 必须快：SessionStart 是同步的。只追加一行、不做网络请求、不读会话记录。
- 只用 Node 自带模块，不依赖仓库的 `node_modules`。
