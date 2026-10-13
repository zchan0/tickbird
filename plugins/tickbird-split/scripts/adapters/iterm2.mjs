// iTerm2 (macOS): AppleScript through osascript. ITERM_SESSION_ID is
// "w0t0p0:<unique id>"; the session with that unique id is split vertically
// (iTerm2 puts the new pane on the right) and the pane runs the program.
// iTerm2 has no pane variables, so the pane opened for an agent is kept in
// panes.json. The first run asks the reader to let the agent control iTerm2.
// Written from iTerm2's AppleScript dictionary; not yet run against a real iTerm2.
import { appleString, remember, remembered, shellLine } from './registry.mjs';

export const name = 'iTerm2';
export const matches = env => Boolean(env.ITERM_SESSION_ID);

/** AppleScript that runs `body` with `s` bound to the session whose unique id is `id`; "" when there is none. */
export const withSession = (id, body) => [
  'tell application "iTerm2"',
  '  repeat with w in windows', '    repeat with t in tabs of w', '      repeat with s in sessions of t',
  `        if (unique id of s) is ${appleString(id)} then`, ...body.map(line => `          ${line}`), '        end if',
  '      end repeat', '    end repeat', '  end repeat',
  '  return ""',
  'end tell',
].join('\n');

export function locate(env, { run, platform = process.platform }) {
  if (platform !== 'darwin') return { skip: '只在 macOS 上能控制 iTerm2' };
  const pane = String(env.ITERM_SESSION_ID).split(':').at(-1);
  if (!pane) return { skip: 'ITERM_SESSION_ID 不完整' };
  const script = text => run('osascript', ['-e', text]);
  const ask = (id, body) => { const result = script(withSession(id, body)); return result.status === 0 ? result.stdout.trim() : ''; };
  return {
    name, pane,
    // The agent runs on the session's terminal: a stale ITERM_SESSION_ID never matches.
    owns: (_agentPid, info) => Boolean(info?.tty) && ask(pane, ['return tty of s']).replace(/^\/dev\//, '') === info.tty,
    find: tag => {
      const id = remembered(env, name, tag);
      return id && ask(id, ['return unique id of s']) === id ? [id] : [];
    },
    open({ argv, cwd, env: extra, tag }) {
      const command = shellLine(['/usr/bin/env', ...Object.entries(extra).map(([key, value]) => `${key}=${value}`), ...argv]);
      // The new pane starts in the agent's directory: cd first, as iTerm2's command has no directory of its own.
      const line = `/bin/sh -c ${shellLine([`cd ${shellLine([cwd])} && exec ${command}`])}`;
      const id = ask(pane, [`set n to (split vertically with same profile command ${appleString(line)})`, 'select s', 'return unique id of n']);
      if (!id) return { error: 'iTerm2 没有开出新栏（可能需要在 系统设置 › 隐私与安全性 › 自动化 里允许控制 iTerm2）' };
      remember(env, name, tag, id);
      return { pane: id };
    },
    focus: ['osascript', '-e', withSession(pane, ['select s', 'tell application "iTerm2" to activate'])],
  };
}
