// Which terminal the agent runs in, innermost first: a multiplexer inside a
// terminal wins (tmux in kitty uses tmux). Variables can be stale, inherited
// from the terminal that started this one, so each adapter also checks that
// the agent really runs in its pane.
//
// An adapter: { name, matches(env), locate(env, { run, which }) } where locate
// returns { skip: reason } or a place: { name, pane, owns(agentPid, info),
// find(tag), open({ argv, cwd, env, tag }), focus: argv }.
import * as kitty from './kitty.mjs';
import * as tmux from './tmux.mjs';

/** Known, but not supported yet: no automatic pane there. */
const later = (name, key) => ({ name, matches: env => Boolean(env[key]), locate: () => ({ skip: `${name} 还不支持自动开栏` }) });

export const ADAPTERS = [later('Zellij', 'ZELLIJ'), tmux, kitty, later('WezTerm', 'WEZTERM_PANE'), later('iTerm2', 'ITERM_SESSION_ID')];

/** The adapters whose variables are set, in the order they are tried. */
export const candidates = env => ADAPTERS.filter(adapter => adapter.matches(env));
