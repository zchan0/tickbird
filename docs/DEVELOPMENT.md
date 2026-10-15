# Development

```sh
npm ci --ignore-scripts
npm test
npm run dev
```

`npm run dev` builds, then opens a separate VS Code development window with a temporary profile. It loads this project and the Codex (`openai.chatgpt`) and Claude Code extensions installed on this machine. It does not install or update them, and does not copy account credentials. It prints where the profile is.

After you change the code, run `npm run build`, then **Developer: Reload Window** in the development window. Refresh in Tickbird only reads the session again; it does not load new code.

You can also press F5 in this project and choose `Run Tickbird Development Host`. In a worktree, open a project that has sessions with `npm run dev -- <project directory>`.

Install from source (for development): `npm run install:all` installs the terminal version, the VS Code version and both plugins from this repository. The plugin marketplace is registered as a local directory and the plugins load in place, so a change takes effect in the next new session. With a development install of `tickbird` present, the pane runs it instead of the program packed in the plugin. To install the parts one at a time: `npm run install:vscode`, `npm run install:terminal`. Uninstall the terminal version with `tickbird uninstall`.

`npm run package:vscode` and `npm run package:terminal` only package; they do not install. The products and the plugins share one version number. Change it with `npm run set-version -- x.y.z`, which also packs `plugins/tickbird-split/program/tickbird.cjs` (the program the plugin carries) again. After you change a plugin under `plugins/`, raise the version, or the agents do not take the update; see [plugins/tickbird-state/README.md](../plugins/tickbird-state/README.md).

GitHub Actions: every push to `main` and every PR runs `npm test` and packages on macOS and Linux (Node 22 and 24). Pushing a tag `v<version>` (the same as `package.json`) publishes a GitHub Release with the `.vsix` and the terminal program. Its notes are that version's section of [CHANGELOG.md](../CHANGELOG.md).

## Releases

Write each change under **Unreleased** in [CHANGELOG.md](../CHANGELOG.md) with its commit, in terms of what users see.

To release, run `npm run release -- x.y.z` (or `patch`, `minor`, `major` for the next version after the latest release). It checks that you are on `main`, that nothing is uncommitted, and that Unreleased is not empty. Then it turns Unreleased into the version's section with today's date, sets the version, runs the tests, commits, pushes, waits for CI, tags, waits for the Release workflow, and installs the release on this machine. If a step fails, it stops there and says why. Fix it and run the same command again: it goes past the steps already done. The check in real VS Code (`npm run test:host`) needs a desktop, so it runs only on this machine.

## Demo pictures

A script draws the GIF and the VS Code screenshot in the README:

```sh
npm run record-demo
```

The demo session is made up ([demo/session.mjs](../demo/session.mjs)), not recorded. The script replays it in time into the terminal version's own rendering and motion, ten frames a second, and draws the agent's pane on the left as Claude Code draws it. Headless Chrome takes the frames and ffmpeg makes the GIF, into `docs/images/`. Run it again after the page changes. It needs Google Chrome and ffmpeg.

## Checks

```sh
npm run check            # type check
npm test                 # unit tests
npm run test:realtime    # incremental reading and live sessions
npm run test:host        # real VS Code host
npm run audit:samples
npm run verify:content
npm run verify:sessions
npm run test:coexistence
```

- `test`: the parsers, the chapter model, rendering safety, the page scripts (jsdom) and more. All fixtures are synthetic; no command in a fixture runs.
- `test:realtime`: record splitting, incremental reading, session discovery and the session picker.
- `test:host`: opens real VS Code on an isolated temporary workspace. It checks that the side bar view takes no editor group, that opening a file in the active column does not cover Tickbird, that detail previews are reused and kept, and that both parsers update incrementally. Then it opens a window with no folder and checks that the side bar explains why, with no warning. A test editor stands in for the agent's chat.
- `audit:samples` / `verify:content` / `verify:sessions`: check source coverage, body bytes and turn grouping against fixed real sessions on this machine. They print only metadata, lengths and hashes, never the text.
- `test:coexistence`: loads the newest Codex and Claude Code extensions installed here, opens their panels with their public commands, then opens Tickbird, opens a detail and keeps it. It checks that each agent's tab stays in its group and is not replaced. The samples are each agent's two newest sessions in this project with enough calls. It does not check what is inside the agents' panels.
- Reports go to `.test-artifacts/`, which is not under version control.

## Limits

- Read-only: no tool or command in a record runs. Detail pages and diffs show what the session recorded at the time. Opening a Read, an image or a link opens the thing itself: for a Read, Tickbird first checks that the lines read then are still in the file, and opens the record of that time if they are not. A web address goes to the browser only when you open it.
- System and developer instructions, hidden reasoning, skills and runtime injections are not shown. Of the thinking, only the summary the harness itself shows is shown; signatures and encrypted content are not read.
- Only plain local single-folder workspaces. In an empty window, a multi-folder workspace or a remote workspace, the side bar says why (an empty window offers Open Folder…), with no warning. Sessions are matched by project directory. Records with no clear turn are listed apart; their turn is not guessed.
- The session picker reads ahead the title and latest message of newer sessions only (files up to 64 MiB). While watching, records are read in parts; a single record over 16 MiB shows no body.
- Not done yet: going back to the place in the original chat; line counts for files a script changed; line numbers for Codex patches.

## Code

- `packages/core/src/`: the page language (`i18n.ts`: every string written in place as `t(english, chinese)`), the data model, the Claude and Codex parsers (`claude.ts`, `codex.ts`), the chapter model (`chapters.ts`), incremental reading and live sessions (`record-stream.ts`, `live-session.ts`), the agent's run state (`agent-status.ts`), and how calls are summed up and their evidence shown (`actions.ts`, `tool-view.ts`, `presentation.ts`, `command-line.ts`). The call line both versions share (`call-line.ts`, `agent-line.ts`) and what opening a call opens (`call-target.ts`) are here too.
- `packages/terminal/src/`: the terminal version (`app.ts` state and keys, `views/` the pages, `watch.ts` reading and redrawing, `selection.ts` drag selection).
- `plugins/tickbird-state/` and `packages/core/src/session-state.ts`: the session state plugin for Claude Code and Codex, and how it is read. The format is in [SESSION_STATE.md](./SESSION_STATE.md) (in Chinese).
- `packages/vscode/src/`: the extension host (`extension.ts`), rendering (`render.ts`, `chapter-view.ts`, `markdown.ts`, `code.ts`, `fonts.ts`), and the page scripts (`live-client.ts`, `follow-client.ts`, `inline-client.ts`).
- `tests/`, `scripts/`: tests you can run again, host checks and real-sample checks.

The webview's CSP and message boundary follow the [VS Code Webview guide](https://code.visualstudio.com/api/extension-guides/webview). Tickbird does not depend on other agents' private state or UI DOM. It reads only the session records they write on this machine, and the run state file Claude Code writes publicly.

## Docs

- In the repository, to share: `README.md`, `README.zh-CN.md`, `docs/`, and the README in each plugin directory. No local paths, real session IDs or session content.
- Local only, not committed: `local/` (the development log `DEVELOPMENT_LOG.md`, old plans in `archived/`), `probes/` (design probes with real session content), `.codex/` (an early prototype).
