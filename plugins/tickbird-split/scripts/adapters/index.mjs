// Which terminal the agent runs in, innermost first: a multiplexer inside a
// terminal wins (tmux in kitty uses tmux). Variables can be stale, inherited
// from the terminal that started this one, so each adapter also checks that
// the agent really runs in its pane.
//
// An adapter: { name, matches(env), locate(env, { run, which }) } where locate
// returns { skip: reason } or a place: { name, pane, owns(agentPid, info),
// find(tag), open({ argv, cwd, env, tag }), focus: argv }.
import * as ghostty from './ghostty.mjs';
import * as iterm2 from './iterm2.mjs';
import * as kitty from './kitty.mjs';
import * as tmux from './tmux.mjs';
import * as wezterm from './wezterm.mjs';
import * as zellij from './zellij.mjs';

// Multiplexers first, then terminals. Where none matches, /tickbird-split:open gives the command to run by hand.
export const ADAPTERS = [zellij, tmux, kitty, wezterm, iterm2, ghostty];

/** The adapters whose variables are set, in the order they are tried. */
export const candidates = env => ADAPTERS.filter(adapter => adapter.matches(env));
