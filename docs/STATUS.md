# 现状

2026-10-11。详细的开发日志只在本地（`local/DEVELOPMENT_LOG.md`），不进仓库。

## 产品与组件

2026-10-12 改名：Agent Sidecar → Tickbird（0.6.0）。旧名字的扩展、插件、插件市场和命令由安装脚本自动移除（`OLD`，`packages/terminal/src/setup.ts`）。本地文件夹仍叫 `agent-sidecar`。

整个仓库用一个版本号（当前 0.5.0），用 `npm run set-version -- x.y.z` 修改。

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| VS Code 版（`zchan0.tickbird`） | 可用 | 左侧主侧栏视图，一页一轮，与终端版同一套排法（设计稿 v8）；点开调用打开它指向的文件、图片、网址或 diff |
| 终端版（`tickbird`） | 可用 | kitty、tmux 里自动开一栏；设计见 [TERMINAL_DESIGN.md](./TERMINAL_DESIGN.md)，之后的改动记在 [TODO.md](./TODO.md) |
| 插件 `tickbird-state` | 可用 | Claude Code 与 Codex 的 hook，写会话状态。格式见 [SESSION_STATE.md](./SESSION_STATE.md) |
| 插件 `tickbird-split` | 可用 | 终端版的自动分屏，只随终端版安装 |

安装：`npm run install:vscode`、`npm run install:terminal`（见 [DEVELOPMENT.md](./DEVELOPMENT.md)）。未在任何市场公开发布。

两个版本共用 core：解析、章节、调用的一行（`call-line.ts`）、点开调用时打开什么（`call-target.ts`）。界面上的规则只写一处。

## 已知问题

- `audit:samples`、`verify:content` 依赖本机固定的真实会话；其中一份 Codex 会话被 Codex 重写过格式，基线需要重建。这几个核对脚本把本机会话的路径写死在代码里，应改为读取不提交的本地配置。
- Codex 回合报错时不触发 `Stop` hook，会话状态停在 working，直到下一条消息；显示不受影响。
- Claude Code 用 `-p` 运行时，后台执行的 `Stop` hook 可能来不及写入；交互使用不受影响。
- 脚本（python、sed 等）改的文件算进 Changes，但没有行数，也没有 diff 可看，点开是那次调用的详情。
- Codex 的补丁不带行号，diff 的行号栏空着。

## 待办

当前的优先级见 [TODO.md](./TODO.md)。

- 两个版本在日常使用中攒问题，归纳成原则后统一改。
- VS Code 版：同时开着多个对话时，跟随「最近活跃」的规则已实现，还没在真实多面板场景里长时间使用。
- 公开分发：扩展市场（需要用户本人注册发布者）、Open VSX、npm 或 brew、公开的插件市场。
