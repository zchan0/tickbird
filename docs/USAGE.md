# Usage

The [README](../README.md) has the short install steps. This page has the details for after you install: how to read each version, how to use it, and what you can run into while you install.

Some text on the page is in Chinese for now. Where this page names it, the English meaning follows in parentheses.

## While you install

- Claude Code before 2.1.275 installs in two steps: `/plugin marketplace add zchan0/tickbird`, then `/plugin install tickbird-split@tickbird`.
- The first time Codex starts, it asks **Hooks need review**. Choose Trust all (or run `/hooks` and press `t`). If you do not trust them, Codex skips these hooks without a word.
- VS Code: also install `tickbird-state` for the agent (the terminal version installs it already). In Claude Code: `/plugin install tickbird-state --marketplace zchan0/tickbird`. In Codex: the same `marketplace add` as in the README, then `plugin add tickbird-state@tickbird`. Without it, you can still choose a session by hand in the side bar, but it does not follow this window's session and does not show Needs approval.
- Which terminals open the pane by themselves: see [TERMINALS.md](./TERMINALS.md).

## Update and uninstall

- Plugins: update or uninstall them in the agent's plugin manager (`/plugin` in Claude Code, `/plugins` in Codex). Both agents get an update only when the plugin's version number changes.
- VS Code: install the new `.vsix`. Uninstall it in the Extensions view.

What the plugins do: `tickbird-state` is a set of hooks that only write the session's state to a file on your machine: which window the session belongs to, whether it waits for your approval, and the long answer on the agent's screen. It shows nothing and does not change how the agent works. `tickbird-split` opens a pane when a session starts, and runs Tickbird in it to show that session, read-only.

The VS Code version and the terminal version lay out a turn the same way: one turn to a page, the calls hung under each tool's name on a tree, and at the end of a turn the Final Answer and the changes, each folded to one line.

## VS Code

1. Click the Tickbird icon in the activity bar (or run `Tickbird: Open Process Observer`). The view opens in the primary side bar. It takes no editor group, so files that other extensions open do not cover it.
2. The view's title bar: choose a session, refresh, and under `…` the coverage records. After the title is the session's name (only the name the agent saved). The session list shows each session's title, source, short ID, last update and latest message, and you can search it. It lists the main sessions of the current project only.
3. One turn to a page. The page head says 「第 n 轮 / 共 N 轮 · start time」 (turn n of N). ‹ › or `[` `]` go to the turn before and after; ☰ or `t` open the contents, one entry a turn, each with its request.
4. A turn, top to bottom:
   - **Prompt**: your request, on a sheet one step lighter than the page: the only raised part of the page. Messages you send during the turn are set the same way.
   - **Agent calls** (subagents) are a block of their own: the tool's name on one line (when the descriptions share a lead, the lead goes on this line, as in `Agent · Name brainstorm`). Each subagent has a dot whose colour is its state (yellow running, green done, red failed, grey stopped), then its description in the body colour. Under it, in grey: background or not, how long, tokens and the number of calls (tokens and the final count of calls come from its notification; while it runs, the time so far and the calls so far). Calls that deal with another agent are set the same way. **SendMessage**: → the task of the agent it went to, the message's summary in grey under it. **Skill**: ◆ the skill's name, its arguments under it. **Workflow**: its name beside the tool's name, what it does after the dot, its phases hung under that, and a last line with background and time.
   - **The agent's words**, and under them the calls that came after, on the page itself: the tool's name (Bash, Read, Edit, Search…) on its own line, the calls hung under it on a tree. Several calls of one tool in a row show the name once. Calls are grey. Colour marks only a failure (red: `exit 1`, `rejected` and so on), the lines a change added and removed (green and red), and a question that waits for your answer (a gold `?`). A command shows the agent's own description of it, or what the command does as read from the command; when a command changes files, the files follow.
   - **A question to you** (Ask) is a line where it was asked, with the answers you chose under it.
   - **Final Answer**: when the turn is over, it folds to one line. Click it to read all of it; if it does not fit, the page scrolls it to the top.
   - **Changes**: how many files the turn changed and the lines in all. Click it for one line a file. Files a script changed are included, without line counts.
5. **Click a call** to open what it points to:
   - Read (and read-only commands such as `cat` and `sed -n`): opens the file in the editor with the lines it read selected. If the file changed and those lines moved, the new place is selected; if the lines are gone, the record of that time opens.
   - An image, a local file or a web address it read: opens in VS Code or the browser.
   - Edit and Write, and files in Changes: open a diff in the editor area, with the line numbers from the record and the changed words in a brighter colour (Claude Code's colours). If the turn changed a file more than once, switch between the changes with ‹ › or `<` `>`.
   - Agent (a Claude Code subagent): if the subagent kept its own record, its turn opens. What it was given is labelled Task (folded to its first 3 lines in the terminal; ⏎ or a click opens and folds it, `y` copies all of it), then its words and calls, then what it gave back, labelled Result, open. While the subagent runs, the page follows its record, with a gold dot breathing at the end. Go from subagent to subagent with `[` `]` (terminal) or click another row (VS Code; 「保留此页」 (keep this page) lets you see two side by side). Codex subagents are not supported yet.
   - Other calls: open a detail page. Its title is what the row says, with the input and the return under it.
   - The next call you open uses the same detail page. Click 「保留此页」 (keep this page) to keep it.
6. **Live**: once a session is chosen, new records are read as they are written.
   - While a turn runs, a gold dot breathes at the end of the page, whether a call runs or the agent works out its next step. The call rows do not move. After 10 minutes with no new record, it says 「无新记录」 (no new records).
   - Background tasks (agents and Bash commands that run in the background): when the turn ends with tasks still out, a grey line at the end says "N background tasks running", but only while the agent still reports its state. When a task reports back, its notification becomes a row in the turn, what the agent says next becomes the new Final Answer, and the answer before goes back into the process.
   - New content comes in one part after another: the agent's words first, then the calls under them.
   - Following: by default the page follows the end of the newest turn, and stays at the end when the turn is over. Scrolling up, opening a call or going to an older turn pauses it, and 「↓ 跟随」 (follow) shows in the page head; click it to go back to the newest turn. If a new turn starts while you read an older one, **New turn** shows at the bottom.
   - Whether the agent runs: for Claude Code, the `~/.claude/sessions/<pid>.json` file that Claude Code keeps (busy or idle); for Codex, the turn-end and interrupt events in the session.
   - **With `tickbird-state` installed** (`npm run install:vscode` installs it): the view follows the session most recently active in this window. When the agent stops for your approval, **Needs approval** shows at the end with the tool and file to approve. Claude Code's words show before they reach the transcript. If you choose another session by hand, following pauses; the notice bar can turn it back on.
7. You can drag over the words of calls, Agent rows and files in Changes, and copy them with Cmd+C. A click still opens them.
8. The coverage records list where each source record went: shown, merged, left out, or not yet supported.

## Terminal

In kitty or tmux, a new Claude Code or Codex session opens a pane beside it (about 48 columns). What it shows and how it lays it out are as in the VS Code version. Press `?` for all the keys. The common ones:

| Key | What it does |
| --- | --- |
| `j` `k` / `↓` `↑` | Select a call or the answer (selecting pauses following) |
| `⏎` | Open the details; open or fold Final Answer and Changes |
| `[` `]` | The turn before / after; in a detail, the call before / after |
| `<` `>` | In a detail: the change before / after to the same file |
| `g` `G` | Start / end (`G` goes back to the newest turn and follows it again) |
| `t` `o` `y` | Contents / open in the editor / copy |
| `a` `q` | Back to the agent / quit |
| Drag | Select words; let go to copy them to the clipboard (a click still opens) |
