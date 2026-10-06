# 现状

2026-10-06。详细的开发日志只在本地（`local/DEVELOPMENT_LOG.md`），不进仓库。

## 产品与组件

整个仓库用一个版本号（当前 0.2.0），用 `npm run set-version -- x.y.z` 修改。

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| VS Code 版（`zchan0.agent-sidecar`） | 可用 | 章节视图、详情、实时更新；装了 `sidecar-state` 时自动跟随本窗口的会话、显示「等你批准」和显示中的长回答 |
| 插件 `sidecar-state` | 可用 | Claude Code 与 Codex 的 hook，写会话状态。格式见 [SESSION_STATE.md](./SESSION_STATE.md) |
| 终端版 | 设计定稿，开发中 | 见 [TERMINAL_DESIGN.md](./TERMINAL_DESIGN.md) |
| 插件 `sidecar-split` | 未开始 | 终端版的自动分屏，随终端版实现 |

安装：`npm run install:vscode`（见 README）。未在任何市场公开发布。

## 已知问题

- `audit:samples`、`verify:content` 依赖本机固定的真实会话；其中一份 Codex 会话被 Codex 重写过格式，基线需要重建。
- 这几个核对脚本把本机会话的路径写死在代码里，应改为读取不提交的本地配置。
- `test:coexistence` 的断言仍是旧的编辑器组布局。
- Codex 回合报错时不触发 `Stop` hook，会话状态停在 working，直到下一条消息；显示不受影响。
- Claude Code 用 `-p` 运行时，后台执行的 `Stop` hook 可能来不及写入；交互使用不受影响。

## 待办

- 终端版：按 TERMINAL_DESIGN 的步骤实现，每步附测试与截图。
- VS Code 版：同时开着多个对话时，跟随「最近活跃」的规则已实现，还没在真实多面板场景里长时间使用。
- 公开分发：扩展市场（需要用户本人注册发布者）、Open VSX、npm 或 brew、公开的插件市场。
