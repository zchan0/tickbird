// Panes opened for an agent, for the terminals that cannot tag a pane
// (WezTerm, iTerm2, Ghostty, Zellij): <state>/tickbird/panes.json, by terminal
// and agent pid. An adapter checks the pane is still there before trusting it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = env => join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'tickbird', 'panes.json');
const read = env => { try { return JSON.parse(readFileSync(file(env), 'utf8')); } catch { return {}; } };

/** The pane last opened in this terminal for this agent, if any. */
export const remembered = (env, terminal, tag) => read(env)[terminal]?.[String(tag)];

export function remember(env, terminal, tag, pane) {
  try {
    const all = read(env);
    all[terminal] = { ...(all[terminal] ?? {}), [String(tag)]: String(pane) };
    const path = file(env);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path + '.tmp', JSON.stringify(all), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  } catch { /* Not remembered: the next start may open a second pane, nothing worse. */ }
}

/** A command line for a shell: each word quoted when it needs to be. */
export const shellLine = words => words.map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`).join(' ');

/** A string inside AppleScript's double quotes. */
export const appleString = text => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
