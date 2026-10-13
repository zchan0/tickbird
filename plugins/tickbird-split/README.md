# tickbird-split

Tickbird 终端版：开始一个 Claude Code 或 Codex 会话时，在 Agent 旁边开一栏 Tickbird，焦点留在 Agent。行为与原理见 [TERMINAL_DESIGN.md](../../docs/TERMINAL_DESIGN.md) 第 9 节；各终端的支持情况见仓库 README 的「安装」。

```
/plugin install tickbird-split --marketplace zchan0/tickbird
```

- 自带 Tickbird 程序（`program/tickbird.cjs`，由 `npm run set-version` 打包），用 hook 所在的 `node` 运行；有开发安装的 `tickbird` 时优先用它。
- 终端适配在 `scripts/adapters/`：kitty、tmux 已实测；WezTerm、Zellij、iTerm2、Ghostty 按各自文档实现，未实测。都不行时，`/tickbird-split:open` 给出手动运行的命令。
- Claude Code 命令：`/tickbird-split:kitty`（检查并经同意打开 kitty 的远程控制），`/tickbird-split:open`（重新打开这一栏）。

- 只有一个 `SessionStart` hook，输出始终为空。决定写进 `~/.local/state/tickbird/split.log`。
- 栏按 Agent 进程绑定：`/clear`、Codex 的 `/new` 后同一栏显示新会话；Agent 退出或被强杀，栏 1 秒内退出。栏里按 `a` 切回 Agent。
- 栏读 `tickbird-state` 写的状态文件，所以两个插件要一起装（Claude Code 按依赖自动装上，Codex 要分别装）。
- Codex 0.157 起默认用共用后台运行 hook。插件会找到终端里的 `codex` 前台；同一目录开着几个 Codex、又分不清刚发消息的是哪个时，不开栏。
- 同一个目录既是 Claude Code 插件，也是 Codex 插件。`scripts/front.mjs` 和 `tickbird-state` 里的同名文件必须一致（测试检查）。
- 只依赖 Node 自带模块，以及 `ps`、`lsof`（macOS）、`kitten` 或 `tmux`。

## 前提

- kitty：开启 socket 远程控制，例如在 `kitty.conf` 里写 `allow_remote_control socket-only` 和 `listen_on unix:${TMPDIR}/kitty-{kitty_pid}`，然后重启 kitty。布局要包含 `splits`。
- tmux：默认配置即可。
- 栏的程序：环境变量 `TICKBIRD_CLI`（脚本用当前 node 运行），否则 PATH 上的 `tickbird`。

## 本地试用

- Claude Code：`TICKBIRD_CLI=<仓库>/dist/packages/terminal/src/cli.js claude --plugin-dir <仓库>/plugins/tickbird-split`（先 `npm run build`）。
- Codex：正式安装见 C3。临时试用可以用 `-c 'hooks.SessionStart=[…]'` 传入 hook，但带 `-c` 时 Codex 不用共用后台；要测共用后台，用单独的 `CODEX_HOME` 和其中的 `hooks.json`。

停用：在 Claude Code 的 `/plugin`、Codex 的 `/plugins` 里关掉 tickbird-split。
