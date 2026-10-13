// Ghostty (macOS, 1.3 or later): AppleScript through osascript. Ghostty does
// not say which terminal a process runs in (no tty), so the agent's terminal is
// taken to be the focused one of the front window, where the agent was just
// started. The new terminal is split off to its left and the program typed into
// it (Ghostty's split runs the default shell). The pane opened for an agent is
// kept in panes.json. The first run asks the reader to let the agent control Ghostty.
// Written from Ghostty's AppleScript documentation; not yet run against a real Ghostty.
import { appleString, remember, remembered, shellLine } from './registry.mjs';

export const name = 'Ghostty';
export const matches = env => env.TERM_PROGRAM === 'ghostty';

const FOCUSED = 'focused terminal of selected tab of front window';

export function locate(env, { run, platform = process.platform }) {
  if (platform !== 'darwin') return { skip: '只在 macOS 上能控制 Ghostty' };
  const script = lines => { const result = run('osascript', ['-e', ['tell application "Ghostty"', ...lines.map(line => `  ${line}`), 'end tell'].join('\n')]); return result.status === 0 ? result.stdout.trim() : ''; };
  const pane = script([`return id of ${FOCUSED}`]);
  if (!pane) return { skip: '读不到 Ghostty 当前的终端（需要 1.3 以上，并允许控制 Ghostty）' };
  const byId = id => `(first terminal whose id is ${appleString(id)})`;
  return {
    name, pane,
    // Only what is focused is known: no check beyond it.
    owns: () => true,
    find: tag => {
      const id = remembered(env, name, tag);
      return id && script([`return id of ${byId(id)}`]) === id ? [id] : [];
    },
    open({ argv, cwd, env: extra, tag }) {
      const line = `cd ${shellLine([cwd])} && exec ${shellLine(['/usr/bin/env', ...Object.entries(extra).map(([key, value]) => `${key}=${value}`), ...argv])}`;
      const id = script([
        `set agent to ${byId(pane)}`,
        'set t to split agent direction left',
        `input text ${appleString(line)} to t`,
        'send key "enter" to t',
        'focus agent',
        'return id of t',
      ]);
      if (!id) return { error: 'Ghostty 没有开出新栏' };
      remember(env, name, tag, id);
      return { pane: id };
    },
    focus: ['osascript', '-e', ['tell application "Ghostty"', `  focus ${byId(pane)}`, 'end tell'].join('\n')],
  };
}
