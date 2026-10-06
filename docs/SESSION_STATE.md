# 会话状态（接入 → 显示端）

状态：已确认（2026-10-05）。实现：插件 `sidecar-state`（`plugins/sidecar-state/`，hook 与两份插件清单）、`packages/core/src/session-state.ts`（读取与折叠）。

接入是给 Claude Code 和 Codex 的一组 hook。它只做一件事：把「当前有哪些会话、各自在做什么」写到本机。VS Code 版和终端版读这些文件，决定跟随哪个会话、显示什么状态。接入不显示任何东西，也不改变 Agent 的任何行为。

会话记录（transcript）仍是内容的唯一来源。会话状态只补会话记录里没有、或来得太晚的三样东西：

1. 这个会话属于哪个窗口（VS Code 窗口或 kitty 窗口）。
2. Agent 是否正在等你批准。
3. 正在显示、但还没写进会话记录的长回答。

## 位置

```
$XDG_STATE_HOME/agent-sidecar/sessions/     默认 ~/.local/state/agent-sidecar/sessions/
  claude-<session_id>.jsonl
  codex-<session_id>.jsonl
```

- 一个会话一个文件。目录权限 0700，文件 0600。
- 文件只追加，不改写。每次 hook 追加一行。并发的 hook（例如每 0.5 秒一段的 `MessageDisplay`）不用加锁。
- 显示端读文件时，从头折叠成当前状态。
- Claude Code 里除 `SessionStart`、`SessionEnd` 外的 hook 都在后台执行（`async: true`），不拖慢 Agent。后台执行时写入的先后可能和发生的先后不一致，所以折叠时按每行的 `t` 排序，流式文字按 `index` 拼接。
- 不订阅 `PostToolUse`：每次工具调用都多一次同步 hook，代价太大。等批准什么时候结束，看会话记录（见下）。

## 记录

第一行是 `start`，写会话的固定信息；之后每行是一个事件。

```jsonc
{"v":1,"t":1791164847514,"e":"start","provider":"claude","session":"<session-id>",
 "transcript":"/Users/…/<session-id>.jsonl","cwd":"/Users/…/project",
 "agentPid":68970,"hostPid":61907,"source":"startup",
 "kitty":{"window":"19","socket":"unix:/…/kitty-1604"}}      // 只在 kitty 里
{"v":1,"t":…,"e":"prompt"}                                    // UserPromptSubmit
{"v":1,"t":…,"e":"approval","tool":"Write","summary":"numbers.txt"}   // PermissionRequest
{"v":1,"t":…,"e":"display","message":"56bd…","index":3,"final":false,"text":"…"}  // MessageDisplay
{"v":1,"t":…,"e":"stop"}                                      // Stop / StopFailure / Codex Interrupt
{"v":1,"t":…,"e":"end","reason":"prompt_input_exit"}         // SessionEnd
```

- `agentPid`：hook 的 `$PPID`，即 claude 进程或 Codex app-server。
- `hostPid`：`agentPid` 的父进程。在 VS Code 里是所在窗口的扩展宿主；在终端里是 shell，不用于匹配。
- `summary`：工具参数的一行摘要，最多 200 字符。不写完整参数。
- `prompt` 事件不记录提示词原文：会话记录里已经有了。
- `display` 只记录 Agent 已经显示在屏幕上的文字，和稍后写进会话记录的内容相同。

## 折叠后的状态

```ts
interface SessionState {
  provider: 'claude' | 'codex'; session: string; transcript?: string; cwd: string;
  agentPid: number; hostPid: number; kitty?: { window: string; socket: string };
  startedAt: number; activeAt: number;            // 最近一次 prompt / approval / display / stop
  phase: 'idle' | 'working' | 'waiting' | 'ended';
  approval?: { tool: string; summary: string; at: number };   // waiting 时才有
  draft?: { message: string; text: string; at: number };      // 正在显示的长回答
}
```

| 事件 | phase | 其它 |
| --- | --- | --- |
| start | idle | |
| prompt | working | 清空 approval、draft |
| approval | waiting | 设置 approval |
| display | 不变 | 同一 message 的 text 依次拼接；message 变了就重新开始。不结束等批准 |
| stop | idle | 清空 approval、draft |
| end | ended | |

Agent 进程（`agentPid`）已经不在时，不论最后一个事件是什么，都按 ended 处理。

两个 Agent 都不通知「批准已处理」。会话记录里出现批准之后的任何新记录（调用结果或拒绝），就说明已处理。显示「等你批准」要用 `awaitingApproval(state, 会话记录最后时间)`，不能只看 `phase`。

## 显示端怎么用

- **VS Code 版**：取 `hostPid` 等于本扩展 `process.pid`、且未结束的会话，跟随 `activeAt` 最新的那个。一个都没有时，回到现在的会话选择器。
- **终端版**：kitty 栏按 `session` 绑定；`/clear`、`/resume` 产生新会话时，用同一 `kitty.window` 的新 `start` 改绑。
- **draft**：会话记录里出现同一段回答后，丢弃 draft。

## 清理

`start` 时顺带删除 7 天前的文件，但只删 Agent 进程已不在的会话。

## 启用与停用

- 装上接入就是启用。停用用 Agent 自己的插件管理：Claude Code 用 `/plugin`，Codex 用 `/plugins`。用户在 Agent 里能看到它、关掉它。
- Codex 的 hook 必须先在 `/hooks` 里信任一次，否则会被静默跳过。安装流程要引导这一步，显示端检测到「Codex 会话没有状态文件」时也要提示。

## 约束

- hook 必须静默：SessionStart 的 stdout 会进入模型上下文。
- hook 必须快：SessionStart 是同步的。只追加一行、不做网络请求、不读会话记录。
- 只用 Node 自带模块，不依赖仓库的 `node_modules`。
