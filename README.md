# Tickbird

**Watch your agent work, step by step, right beside it.**

English · [中文](./README.zh-CN.md)

![Claude Code on the left, Tickbird on the right: the agent's words, the commands it runs and the files it changes come in as it works](./docs/images/demo.gif)

Tickbird reads the session records that Claude Code and Codex write on your machine, and lays out each turn as one page: what you asked, what the agent said, which commands it ran and which files it changed, and how it answered. It only reads. It sends nothing to the agent and runs none of the commands in the records.

- **Two versions.** A pane beside the agent in your terminal, or a view in the VS Code side bar.
- **Live.** New steps come in as the agent works. When the agent stops to ask for your approval, Tickbird says so.
- **Open the evidence.** A file the agent read opens with those lines selected, a change opens as a diff, and a command shows its output.

Some of the labels on the page are in Chinese for now.

## Two versions

| Terminal | VS Code |
| --- | --- |
| Opens beside the agent in kitty, tmux and other terminals. See the demo above. | Sits in the primary side bar. Details open in the editor area. |
| | <img src="./docs/images/vscode.png" width="320" alt="The same turn in the VS Code side bar"> |

## Install

You need Node.js 22 or later, and Claude Code or Codex.

### Terminal

In Claude Code:

```
/plugin install tickbird-split --marketplace zchan0/tickbird
```

In Codex:

```sh
codex plugin marketplace add zchan0/tickbird
codex plugin add tickbird-state@tickbird
codex plugin add tickbird-split@tickbird
```

New agent sessions then open a Tickbird pane beside them. In kitty, turn on remote control first: run `/tickbird-split:kitty` in Claude Code. For other terminals, see [terminal support](./docs/TERMINALS.md).

### VS Code

Download `tickbird-<version>.vsix` from [Releases](https://github.com/zchan0/tickbird/releases), then:

```sh
code --install-extension tickbird-<version>.vsix
```

Also install the `tickbird-state` plugin for your agent (the terminal version installs it already): run `/plugin install tickbird-state --marketplace zchan0/tickbird` in Claude Code. With it, the side bar follows this window's session and shows when the agent waits for your approval.

## Docs

These are in Chinese for now:

- [Usage](./docs/USAGE.md): keys, what opens when you click a step, live updates and following.
- [Terminal support](./docs/TERMINALS.md): which terminals open the pane by themselves.
- [Development](./docs/DEVELOPMENT.md): build from source, tests, releases.
- [Changelog](./CHANGELOG.md)

## License

[MIT](./LICENSE)
