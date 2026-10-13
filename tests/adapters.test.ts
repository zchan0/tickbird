import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './temp';

// The terminals whose adapters were written from their documentation (WezTerm,
// Zellij, iTerm2, Ghostty): each is driven here by a fake of its own command,
// which answers as the documentation says and records what it was asked.
const adapters = resolve(__dirname, '../../plugins/tickbird-split/scripts/adapters');
type Result = { status: number; stdout: string; stderr: string };
type Place = { name: string; pane: string; owns(pid: number, info: { tty: string }): boolean; find(tag: number): string[]; open(spec: { argv: string[]; cwd: string; env: Record<string, string>; tag: number }): { pane?: string; error?: string }; focus: string[] };
type Adapter = { name: string; matches(env: NodeJS.ProcessEnv): boolean; locate(env: NodeJS.ProcessEnv, tools: unknown): Place | { skip: string } };
const load = (name: string) => require(join(adapters, `${name}.mjs`)) as Adapter;
const ok = (stdout = ''): Result => ({ status: 0, stdout, stderr: '' });
const fake = (answer: (command: string, args: string[]) => Result) => {
  const calls: string[][] = [];
  return { calls, run: (command: string, args: string[]) => { calls.push([command, ...args]); return answer(command, args); }, which: (name: string) => `/usr/local/bin/${name}` };
};
const ARGV = ['/usr/bin/node', '/plugin/program/tickbird.cjs', 'watch', '--agent', '501', '--focus', '[]'];
const placeOf = (adapter: Adapter, env: NodeJS.ProcessEnv, tools: unknown): Place => {
  const place = adapter.locate(env, tools);
  assert.ok(!('skip' in place), JSON.stringify(place));
  return place as Place;
};

test('WezTerm: the agent’s pane by its tty, a pane to its left a fixed width across, the focus back on the agent', () => {
  const state = tempDir('wezterm');
  const panes = [{ pane_id: 3, tty_name: '/dev/ttys004', size: { cols: 160 } }];
  const tools = fake((_command, args) => {
    if (args[1] === 'list') return ok(JSON.stringify(panes));
    if (args[1] === 'split-pane') { panes.push({ pane_id: 9, tty_name: '/dev/ttys009', size: { cols: 48 } }); return ok('9\n'); }
    return ok();
  });
  const wezterm = load('wezterm');
  assert.equal(wezterm.matches({ WEZTERM_PANE: '3' }), true);
  const env = { WEZTERM_PANE: '3', XDG_STATE_HOME: state };
  const place = placeOf(wezterm, env, tools);
  assert.equal(place.owns(501, { tty: 'ttys004' }), true);
  assert.equal(place.owns(501, { tty: 'ttys099' }), false, 'A WEZTERM_PANE inherited from another terminal');
  assert.deepEqual(place.find(501), []);
  assert.deepEqual(place.open({ argv: ARGV, cwd: '/work', env: { XDG_STATE_HOME: state }, tag: 501 }), { pane: '9' });
  const split = tools.calls.find(call => call[2] === 'split-pane')!;
  assert.deepEqual(split.slice(0, split.indexOf('--') + 1), ['/usr/local/bin/wezterm', 'cli', 'split-pane', '--pane-id', '3', '--left', '--cells', '48', '--cwd', '/work', '--']);
  assert.deepEqual(split.slice(split.indexOf('--') + 1), ['env', `XDG_STATE_HOME=${state}`, ...ARGV]);
  assert.deepEqual(tools.calls.at(-1), ['/usr/local/bin/wezterm', 'cli', 'activate-pane', '--pane-id', '3']);
  // Found again while it is there; gone, not found.
  assert.deepEqual(place.find(501), ['9']);
  panes.pop();
  assert.deepEqual(place.find(501), []);
  assert.deepEqual(place.focus, ['/usr/local/bin/wezterm', 'cli', 'activate-pane', '--pane-id', '3']);
});

test('Zellij: a pane named for the agent, moved to its left, the focus back on the agent; found again by its name', () => {
  let listed = 'terminal_1 claude\n';
  const tools = fake((_command, args) => {
    if (args[3] === 'list-panes') return ok(listed);
    if (args[3] === 'new-pane') { listed += 'terminal_2 Tickbird 501\n'; return ok(); }
    return ok();
  });
  const zellij = load('zellij');
  const env = { ZELLIJ: '0', ZELLIJ_PANE_ID: '1', ZELLIJ_SESSION_NAME: 'work' };
  assert.deepEqual(zellij.locate({ ZELLIJ: '0' }, tools), { skip: 'Zellij 环境变量不完整（ZELLIJ_PANE_ID、ZELLIJ_SESSION_NAME）' });
  const place = placeOf(zellij, env, tools);
  assert.deepEqual(place.find(501), []);
  assert.deepEqual(place.open({ argv: ARGV, cwd: '/work', env: {}, tag: 501 }), { pane: 'Tickbird 501' });
  const steps = tools.calls.filter(call => call[4] !== 'list-panes').map(call => call.slice(1, 5).join(' '));
  assert.deepEqual(steps, ['--session work action new-pane', '--session work action move-pane', '--session work action focus-pane-id']);
  const opened = tools.calls.find(call => call[4] === 'new-pane')!;
  assert.deepEqual(opened.slice(5, opened.indexOf('--')), ['--direction', 'right', '--close-on-exit', '--name', 'Tickbird 501', '--cwd', '/work']);
  assert.deepEqual(tools.calls.find(call => call[4] === 'move-pane')!.slice(5), ['left']);
  assert.deepEqual(tools.calls.find(call => call[4] === 'focus-pane-id')!.slice(5), ['terminal_1']);
  assert.deepEqual(place.find(501), ['Tickbird 501']);
});

test('iTerm2: the agent’s session by its unique id and tty, split with the program, the session selected again', () => {
  const state = tempDir('iterm2');
  const scripts: string[] = [];
  const tools = { ...fake((_command, args) => {
    const text = args[1];
    scripts.push(text);
    if (text.includes('return tty of s')) return ok('/dev/ttys004\n');
    if (text.includes('split vertically')) return ok('NEW-ID\n');
    if (text.includes('return unique id of s')) return ok(text.includes('"NEW-ID"') ? 'NEW-ID\n' : '\n');
    return ok();
  }), platform: 'darwin' };
  const iterm2 = load('iterm2');
  const env = { ITERM_SESSION_ID: 'w0t0p0:AGENT-ID', XDG_STATE_HOME: state };
  assert.deepEqual(iterm2.locate(env, { ...tools, platform: 'linux' }), { skip: '只在 macOS 上能控制 iTerm2' });
  const place = placeOf(iterm2, env, tools);
  assert.equal(place.pane, 'AGENT-ID');
  assert.equal(place.owns(501, { tty: 'ttys004' }), true);
  assert.equal(place.owns(501, { tty: 'ttys005' }), false);
  assert.deepEqual(place.find(501), []);
  assert.deepEqual(place.open({ argv: ARGV, cwd: "/work/it's here", env: { XDG_STATE_HOME: state }, tag: 501 }), { pane: 'NEW-ID' });
  const split = scripts.find(text => text.includes('split vertically'))!;
  assert.match(split, /if \(unique id of s\) is "AGENT-ID" then/);
  assert.match(split, /select s/);
  // The program and its directory reach the shell whole: quoted for sh, then escaped for AppleScript.
  // Undo AppleScript's escaping, then let a real shell say what `sh -c` is given.
  const literal = /command "((?:[^"\\]|\\.)*)"/.exec(split)![1].replace(/\\(.)/g, '$1');
  assert.ok(literal.startsWith('/bin/sh -c '), literal);
  const given = spawnSync('/bin/sh', ['-c', `printf '%s' ${literal.slice('/bin/sh -c '.length)}`], { encoding: 'utf8' }).stdout;
  assert.equal(given, `cd '/work/it'\\''s here' && exec /usr/bin/env XDG_STATE_HOME=${state} ${ARGV.slice(0, -1).join(' ')} '[]'`);
  assert.deepEqual(place.find(501), ['NEW-ID']);
  assert.equal(place.focus[0], 'osascript');
});

test('Ghostty: the focused terminal is the agent’s; a terminal split to its left, the program typed in, the focus back', () => {
  const state = tempDir('ghostty');
  const scripts: string[] = [];
  const tools = { ...fake((_command, args) => {
    const text = args[1];
    scripts.push(text);
    if (text.includes('return id of focused terminal')) return ok('T1\n');
    if (text.includes('split agent direction left')) return ok('T2\n');
    if (text.includes('whose id is "T2"')) return ok('T2\n');
    return ok();
  }), platform: 'darwin' };
  const ghostty = load('ghostty');
  assert.equal(ghostty.matches({ TERM_PROGRAM: 'ghostty' }), true);
  const env = { TERM_PROGRAM: 'ghostty', XDG_STATE_HOME: state };
  const place = placeOf(ghostty, env, tools);
  assert.equal(place.pane, 'T1');
  assert.deepEqual(place.open({ argv: ARGV, cwd: '/work', env: {}, tag: 501 }), { pane: 'T2' });
  const opened = scripts.find(text => text.includes('split agent direction left'))!;
  assert.deepEqual(opened.split('\n').map(line => line.trim()).slice(1, -1).map(line => line.split(' ').slice(0, 2).join(' ')),
    ['set agent', 'set t', 'input text', 'send key', 'focus agent', 'return id']);
  assert.match(opened, /input text "cd \/work && exec \/usr\/bin\/env \/usr\/bin\/node \/plugin\/program\/tickbird.cjs watch --agent 501 --focus '\[\]'" to t/);
  assert.deepEqual(place.find(501), ['T2']);
  // Without AppleScript support (before 1.3) or permission: no pane, and why.
  assert.deepEqual(ghostty.locate(env, { ...fake(() => ({ status: 1, stdout: '', stderr: 'not allowed' })), platform: 'darwin' }), { skip: '读不到 Ghostty 当前的终端（需要 1.3 以上，并允许控制 Ghostty）' });
});

test('every adapter says it was written from documentation until it has run against the real terminal', () => {
  for (const name of ['wezterm', 'zellij', 'iterm2', 'ghostty']) assert.match(readFileSync(join(adapters, `${name}.mjs`), 'utf8'), /not yet run against a real/);
});
