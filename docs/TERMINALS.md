# Terminal support

With the terminal version installed, each new Claude Code or Codex session opens a Tickbird pane beside it, and the focus stays on the agent. Sessions that are already open are not affected. For how it works, see section 9 of [TERMINAL_DESIGN.md](./TERMINAL_DESIGN.md) (in Chinese).

| Terminal | Opens the pane | Notes |
| --- | --- | --- |
| kitty | ✅ | Needs remote control. Run `/tickbird-split:kitty` in Claude Code: it checks, and with your consent backs up kitty.conf and adds two lines. Then quit kitty completely and open it again. |
| tmux (in any terminal) | ✅ | No setup. |
| WezTerm | ✅ not tested | Made from WezTerm's docs (`wezterm cli split-pane`). |
| Zellij | ✅ not tested | Made from Zellij's docs. The pane opens on the right, then moves to the left. |
| iTerm2 (macOS) | ✅ not tested | Through AppleScript; the pane opens to the right of the agent. The first time, macOS asks you to allow control of iTerm2. |
| Ghostty (macOS, 1.3 or later) | ✅ not tested | Through AppleScript (a preview feature in Ghostty). It splits the terminal that has the focus in that window. The first time, macOS asks you to allow control of Ghostty. |
| Other terminals | — | Run `/tickbird-split:open` in Claude Code. It gives you one command and copies it to the clipboard; run it in a new tab or window. |

If you close the pane, open it again with `/tickbird-split:open`. To stop the pane from opening by itself, turn off `tickbird-split` in the agent's plugin manager.
