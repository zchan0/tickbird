import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionState } from '../packages/core/src/session-state';
import { agentSession, parseWatchArgs, resolveSession } from '../packages/terminal/src/watch';

// The plugin is plain ES modules with Node's own modules only; Node loads them with require.
const pluginDir = resolve(__dirname, '../../plugins/sidecar-split/scripts');
type Tools = { run(command: string, args: string[]): { status: number; stdout: string; stderr: string }; which(name: string): string | undefined; input?: (tty: string) => number };
const split = require(join(pluginDir, 'split.mjs')) as {
  handle(provider: string, agentPid: number, input: object, env: NodeJS.ProcessEnv, tools: Tools): string | undefined;
  interactive(provider: string, args: string): boolean;
  paneArgv(program: string[], agentPid: number, focus: string[]): string[];
};
const adapters = require(join(pluginDir, 'adapters/index.mjs')) as { candidates(env: NodeJS.ProcessEnv): Array<{ name: string }> };

const AGENT = 4242;
const START = { hook_event_name: 'SessionStart', session_id: 's-1', source: 'startup', cwd: '/work/project' };
const KITTY = { KITTY_WINDOW_ID: '19', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1' };
const TMUX = { TMUX: '/tmp/tmux-501/default,123,0', TMUX_PANE: '%3' };
const CLI = { AGENT_SIDECAR_CLI: resolve(__dirname, '../packages/terminal/src/cli.js'), PATH: '/usr/bin', XDG_STATE_HOME: '/state' };

/**
 * Stands in for ps, kitten and tmux. Records every command; answers as a
 * terminal where the agent runs on ttys005 in kitty window 19 and tmux pane %3.
 */
function fakeTools(options: { tty?: string; args?: string; kittyAgent?: number; tmuxTty?: string; existing?: boolean } = {}) {
  const calls: string[][] = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const tools: Tools = {
    which: name => `/bin/${name}`,
    run(command, args) {
      calls.push([command, ...args]);
      if (command === 'ps') return ok(`${options.tty ?? 'ttys005'} ${options.args ?? 'claude'}\n`);
      if (command.endsWith('kitten')) {
        const sub = args[3], match = args[5];
        if (sub === 'ls' && match === 'id:19') return ok(JSON.stringify([{ tabs: [{ windows: [{ id: 19, foreground_processes: [{ pid: options.kittyAgent ?? AGENT }] }] }] }]));
        if (sub === 'ls') return options.existing ? ok(JSON.stringify([{ tabs: [{ windows: [{ id: 20 }] }] }])) : { status: 1, stdout: '', stderr: 'No matching windows' };
        if (sub === 'launch') return ok('21\n');
        return ok();
      }
      if (command.endsWith('tmux')) {
        const sub = args[2];
        if (sub === 'list-panes') return ok(`%3\t/dev/${options.tmuxTty ?? 'ttys005'}\t\n%4\t/dev/ttys009\t${options.existing ? AGENT : ''}\n`);
        if (sub === 'split-window') return ok('%7\n');
        return ok();
      }
      return { status: 127, stdout: '', stderr: 'unknown' };
    },
  };
  return { tools, calls, find: (word: string) => calls.find(call => call.includes(word)) };
}

test('adapters are tried innermost first; unknown terminals get none', () => {
  const names = (env: NodeJS.ProcessEnv) => adapters.candidates(env).map(adapter => adapter.name);
  assert.deepEqual(names(KITTY), ['kitty']);
  assert.deepEqual(names(TMUX), ['tmux']);
  assert.deepEqual(names({ ...KITTY, ...TMUX }), ['tmux', 'kitty'], 'tmux inside kitty uses tmux');
  assert.deepEqual(names({ ...KITTY, ZELLIJ: '0' }), ['Zellij', 'kitty']);
  assert.deepEqual(names({ WEZTERM_PANE: '1', ITERM_SESSION_ID: 'w0t0p0:x' }), ['WezTerm', 'iTerm2']);
  assert.deepEqual(names({ TERM_PROGRAM: 'Apple_Terminal' }), []);
  // Terminal.app started from a kitty shell keeps kitty's variables; kitty itself sets TERM=xterm-kitty.
  assert.deepEqual(names({ ...KITTY, TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }), []);
  assert.deepEqual(names({ ...KITTY, TERM: 'xterm-kitty', TERM_PROGRAM: 'Apple_Terminal' }), ['kitty']);
  assert.deepEqual(names({ ...KITTY, TERM: 'xterm-256color' }), ['kitty']);
});

test('kitty: a pane beside the agent, focus kept, tagged with the agent and told how to focus it', () => {
  const { tools, find } = fakeTools();
  const outcome = split.handle('claude', AGENT, START, { ...KITTY, ...CLI }, tools);
  assert.match(outcome!, /kitty：在 19 旁开栏 21/);
  const launch = find('launch')!;
  assert.deepEqual(launch.slice(1, 4), ['@', '--to', 'unix:/tmp/kitty-1']);
  for (const arg of ['--keep-focus', '--location=vsplit', `sidecar_agent=${AGENT}`, '/work/project', 'PATH=/usr/bin', 'XDG_STATE_HOME=/state']) assert.ok(launch.includes(arg), arg);
  assert.equal(launch[launch.indexOf('--next-to') + 1], 'id:19');
  const command = launch.slice(launch.indexOf(process.execPath));
  assert.deepEqual(command, [process.execPath, CLI.AGENT_SIDECAR_CLI, 'watch', '--agent', String(AGENT), '--focus',
    JSON.stringify(['/bin/kitten', '@', '--to', 'unix:/tmp/kitty-1', 'focus-window', '--match', 'id:19'])]);
});

test('tmux: a detached split of the agent’s pane, tagged afterwards', () => {
  const { tools, calls, find } = fakeTools();
  const outcome = split.handle('codex', AGENT, START, { ...TMUX, ...CLI }, tools);
  assert.match(outcome!, /tmux：在 %3 旁开栏 %7/);
  const splitWindow = find('split-window')!;
  assert.deepEqual(splitWindow.slice(0, 3), ['/bin/tmux', '-S', '/tmp/tmux-501/default']);
  for (const arg of ['-h', '-d', '-P']) assert.ok(splitWindow.includes(arg), arg);
  assert.equal(splitWindow[splitWindow.indexOf('-t') + 1], '%3');
  assert.equal(splitWindow[splitWindow.indexOf('-c') + 1], '/work/project');
  assert.deepEqual(calls.at(-1), ['/bin/tmux', '-S', '/tmp/tmux-501/default', 'set-option', '-p', '-t', '%7', '@sidecar_agent', String(AGENT)]);
  const focus = JSON.parse(splitWindow.at(-1)!);
  assert.deepEqual(focus, ['/bin/tmux', '-S', '/tmp/tmux-501/default', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3']);
});

test('variables inherited from another terminal are not trusted', () => {
  // tmux variables, but the agent is not on that pane's terminal: kitty is next.
  const stale = fakeTools({ tmuxTty: 'ttys001' });
  assert.match(split.handle('claude', AGENT, START, { ...TMUX, ...KITTY, ...CLI }, stale.tools)!, /^kitty：/);
  assert.equal(stale.find('split-window'), undefined);
  // kitty variables, but the agent is not in that window.
  const elsewhere = fakeTools({ kittyAgent: 1 });
  assert.match(split.handle('claude', AGENT, START, { ...KITTY, ...CLI }, elsewhere.tools)!, /不在支持自动开栏的终端里/);
  assert.equal(elsewhere.find('launch'), undefined);
});

test('one pane per agent: a later session start leaves it to rebind', () => {
  for (const env of [KITTY, TMUX]) {
    const { tools, find } = fakeTools({ existing: true });
    assert.match(split.handle('claude', AGENT, { ...START, source: 'clear' }, { ...env, ...CLI }, tools)!, /已有栏/);
    assert.equal(find('launch') ?? find('split-window'), undefined);
  }
});

test('no pane where it would not belong', () => {
  const none = (outcome: string | undefined, pattern: RegExp, calls: string[][]) => {
    assert.match(outcome!, pattern);
    assert.ok(!calls.some(call => call.includes('launch') || call.includes('split-window')));
  };
  let fake = fakeTools({ tty: '??' });
  none(split.handle('claude', AGENT, START, { ...KITTY, ...CLI }, fake.tools), /不在终端里/, fake.calls);
  fake = fakeTools({ args: 'claude --model x -p hello' });
  none(split.handle('claude', AGENT, START, { ...KITTY, ...CLI }, fake.tools), /非交互/, fake.calls);
  fake = fakeTools({ args: '/opt/codex exec fix it' });
  none(split.handle('codex', AGENT, START, { ...KITTY, ...CLI }, fake.tools), /非交互/, fake.calls);
  fake = fakeTools();
  none(split.handle('claude', AGENT, { ...START, source: 'compact' }, { ...KITTY, ...CLI }, fake.tools), /压缩/, fake.calls);
  none(split.handle('claude', AGENT, START, { ...KITTY, AGENT_SIDECAR_CLI: '/missing/cli.js' }, fake.tools), /找不到 agent-sidecar/, fake.calls);
  none(split.handle('claude', AGENT, START, { KITTY_WINDOW_ID: '19', ...CLI }, fake.tools), /socket 远程控制/, fake.calls);
  none(split.handle('claude', AGENT, START, { ZELLIJ: '0', ...KITTY, ...CLI }, fake.tools), /Zellij 还不支持/, fake.calls);
  none(split.handle('claude', AGENT, START, { TERM_PROGRAM: 'Apple_Terminal', ...CLI }, fake.tools), /不在支持自动开栏的终端里/, fake.calls);
  assert.equal(split.handle('claude', AGENT, { ...START, hook_event_name: 'SessionEnd' }, { ...KITTY, ...CLI }, fake.tools), undefined);
  assert.equal(split.interactive('claude', 'claude --resume abc'), true);
  assert.equal(split.interactive('codex', 'codex resume --last'), true);
});

// The hook as the agents run it: a separate node process with JSON on stdin.
test('the hook prints nothing, never fails, and logs what it decided', () => {
  const home = mkdtempSync(join(tmpdir(), 'sidecar-split-'));
  const hook = join(pluginDir, 'split.mjs');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: home, TERM_PROGRAM: 'Apple_Terminal', AGENT_SIDECAR_CLI: CLI.AGENT_SIDECAR_CLI };
  for (const input of [JSON.stringify(START), 'not json', '']) {
    const result = spawnSync(process.execPath, [hook, 'claude', String(process.pid)], { input, env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'Nothing reaches the model');
    assert.equal(result.stderr, '');
  }
  const log = readFileSync(join(home, 'agent-sidecar', 'split.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1, 'Only the session start is logged');
  assert.match(log[0], /claude s-1 startup · /);
  // An unwritable log is not the agent's problem either.
  const blocked = mkdtempSync(join(tmpdir(), 'sidecar-split-'));
  writeFileSync(join(blocked, 'agent-sidecar'), 'a file where a directory should be');
  const result = spawnSync(process.execPath, [hook, 'claude', '1'], { input: JSON.stringify(START), env: { ...env, XDG_STATE_HOME: blocked }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('the pane’s command line round-trips through watch’s arguments', () => {
  const focus = ['/bin/tmux', '-S', '/tmp/a b', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'];
  const argv = split.paneArgv(['/usr/local/bin/agent-sidecar'], AGENT, focus);
  assert.equal(argv[1], 'watch');
  assert.deepEqual(parseWatchArgs(argv.slice(2)), { agent: AGENT, focus });
  assert.deepEqual(parseWatchArgs(['abc-1']), { target: 'abc-1' });
  assert.deepEqual(parseWatchArgs([]), {});
  for (const bad of [['--agent', 'x'], ['--agent', '1'], ['--focus', '[]'], ['--focus', '{"a":1}'], ['--focus'], ['--bogus'], ['a', 'b']]) {
    assert.ok('error' in parseWatchArgs(bad), bad.join(' '));
  }
});

test('the pane follows its agent from session to session', () => {
  const state = (session: string, agentPid: number, activeAt: number, phase: SessionState['phase'] = 'idle'): SessionState =>
    ({ provider: 'claude', session, cwd: '/p', agentPid, hostPid: 1, startedAt: activeAt, activeAt, phase });
  const before = [state('old', AGENT, 10, 'working'), state('other', 7, 50)];
  assert.equal(agentSession(before, AGENT)?.session, 'old');
  // /clear: the old session ended, the next not started yet: none is current.
  assert.equal(agentSession([state('old', AGENT, 10, 'ended'), state('other', 7, 50)], AGENT), undefined);
  const after = [state('old', AGENT, 10, 'ended'), state('new', AGENT, 20), state('other', 7, 50)];
  assert.equal(agentSession(after, AGENT)?.session, 'new');
  // /resume of an older session: its file gains a new start, so it is the active one.
  assert.equal(agentSession([state('new', AGENT, 20, 'ended'), state('resumed', AGENT, 30)], AGENT)?.session, 'resumed');
});

// Codex's shared background server runs every Codex's hooks; the session shows in a `codex` front.
const front = require(join(pluginDir, 'front.mjs')) as {
  frontOf(agentPid: number, cwd: string, options: { exec: Tools['run']; input?: (tty: string) => number; now?: number; platform?: string }): { pid?: number; env?: Record<string, string>; server?: number; ambiguous?: number[]; missing?: boolean };
};
const SERVER = 900;
const SERVER_ARGS = '/Users/me/.codex/packages/app-server-daemon/releases/0.161.0/bin/codex app-server --listen unix:// --managed-daemon';
/** A machine with Codex fronts: 501 and 502 in /work/project, 503 elsewhere, plus things that are not fronts. */
function codexMachine(fronts = [[501, '/work/project'], [502, '/work/project'], [503, '/work/other']] as Array<[number, string]>) {
  const env: Record<number, string> = {
    501: ' TERM=xterm-kitty TMUX=/tmp/tmux-501/default,1,0 TMUX_PANE=%3 PATH=/usr/bin EDITOR=code --wait AGENT_SIDECAR_CLI=' + CLI.AGENT_SIDECAR_CLI,
    502: ' KITTY_WINDOW_ID=19 KITTY_LISTEN_ON=unix:/tmp/kitty-1 PATH=/usr/bin AGENT_SIDECAR_CLI=' + CLI.AGENT_SIDECAR_CLI,
  };
  const calls: string[][] = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fake = new Map<string, ReturnType<Tools['run']>>();
  const run: Tools['run'] = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ps' && args[0] === '-E') { const pid = Number(args.at(-1)); return ok(`codex --yolo${env[pid] ?? ''}\n`); }
    if (command === 'ps' && args[0] === '-A') return ok([
      `  ${SERVER} ??       ${SERVER_ARGS}`, '  600 ttys001  codex exec fix it', '  601 ttys002  claude', '  602 ??       codex --yolo',
      ...fronts.map(([pid], index) => `  ${pid} ttys01${index}  codex --yolo`)].join('\n') + '\n');
    if (command === 'ps') { const pid = Number(args.at(-1)); return ok(pid === SERVER ? `??       ${SERVER_ARGS}\n` : `ttys010  codex --yolo\n`); }
    if (command === 'lsof') return ok(fronts.map(([pid, dir]) => `p${pid}\nfcwd\nn${dir}`).join('\n') + '\n');
    return fake.get(command) ?? { status: 1, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('the server’s session is shown by the one codex front in its directory', () => {
  const one = codexMachine([[501, '/work/project'], [503, '/work/other']]);
  const found = front.frontOf(SERVER, '/work/project', { exec: one.run, platform: 'darwin' });
  assert.equal(found.pid, 501);
  assert.equal(found.server, SERVER);
  assert.equal(found.env!.TMUX_PANE, '%3');
  assert.equal(found.env!.EDITOR, 'code --wait', 'A value runs until the next NAME=');
  assert.ok(!one.calls.some(call => call.includes('600') || call.includes('602')), 'codex exec and codex without a terminal are no fronts');
  // Two in one directory: the one whose terminal just took the message (ttys010 is 501's, ttys011 502's).
  const two = codexMachine(), now = 100_000;
  const typed = (at: Record<string, number>) => ({ exec: two.run, now, platform: 'darwin', input: (tty: string) => at[tty] ?? 0 });
  assert.equal(front.frontOf(SERVER, '/work/project', typed({ ttys010: now - 500, ttys011: now - 60_000 })).pid, 501);
  assert.equal(front.frontOf(SERVER, '/work/project', typed({ ttys010: now - 9_000, ttys011: now - 300 })).pid, 502);
  assert.deepEqual(front.frontOf(SERVER, '/work/project', typed({ ttys010: now - 500, ttys011: now - 1_500 })).ambiguous, [501, 502], 'Too close to tell');
  assert.deepEqual(front.frontOf(SERVER, '/work/project', typed({ ttys010: now - 40_000, ttys011: now - 90_000 })).ambiguous, [501, 502], 'Nobody typed just now');
  assert.equal(front.frontOf(SERVER, '/work/none', typed({})).missing, true);
  // Anything that is not the shared server is its own front: Claude, embedded Codex, Codex in VS Code.
  assert.deepEqual(front.frontOf(501, '/work/project', { exec: two.run, platform: 'darwin' }), { pid: 501, info: { tty: 'ttys010', args: 'codex --yolo' } });
});

test('Codex through its server: the pane goes beside the front, in the front’s terminal, never the server’s', () => {
  const machine = codexMachine([[501, '/work/project'], [503, '/work/other']]);
  const commands: string[][] = [];
  const terminal = fakeTools({ tmuxTty: 'ttys010' });
  const tools: Tools = { which: terminal.tools.which, run: (command, args) => {
    if (command === 'ps' || command === 'lsof') return machine.run(command, args);
    commands.push([command, ...args]);
    return terminal.tools.run(command, args);
  } };
  // The server was started from another kitty window long ago: its variables must not be used.
  const stale = { KITTY_WINDOW_ID: '59', KITTY_LISTEN_ON: 'unix:/tmp/old', XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'sidecar-state-')) };
  const outcome = split.handle('codex', SERVER, START, stale, tools);
  assert.match(outcome!, /^tmux：在 %3 旁开栏 %7（Agent 501，Codex 前台，后台 900）/);
  const splitWindow = commands.find(call => call.includes('split-window'))!;
  assert.equal(splitWindow[splitWindow.indexOf('--agent') + 1], '501', 'The pane follows the front, which exits with the session');
  assert.ok(!commands.some(call => call.includes('unix:/tmp/old')));
  assert.ok(splitWindow.includes(`XDG_STATE_HOME=${stale.XDG_STATE_HOME}`), 'The pane reads the state where the hooks write it');
  assert.match(split.handle('codex', SERVER, START, stale, { which: tools.which, run: codexMachine().run, input: () => 0 })!, /同一目录有 2 个 Codex（501, 502）/);
  assert.match(split.handle('codex', SERVER, { ...START, cwd: '/work/none' }, stale, { which: tools.which, run: codexMachine().run })!, /找不到它在终端里的前台/);
});

test('both plugins carry the same front.mjs', () => {
  const copy = (plugin: string) => readFileSync(resolve(__dirname, `../../plugins/${plugin}/scripts/front.mjs`), 'utf8');
  assert.equal(copy('sidecar-state'), copy('sidecar-split'), 'Edit one, copy it to the other');
});

test('sidecar-state records the front as the Codex session’s agent, with its window, and the server beside it', () => {
  const state = require(resolve(__dirname, '../../plugins/sidecar-state/scripts/hook.mjs')) as {
    record(provider: string, agentPid: number, input: object, now: number, env: NodeJS.ProcessEnv, front?: object): Record<string, unknown>;
  };
  const stale = { KITTY_WINDOW_ID: '59', KITTY_LISTEN_ON: 'unix:/tmp/old' };
  const viaServer = state.record('codex', SERVER, START, 1, stale, { pid: process.pid, server: SERVER, env: { KITTY_WINDOW_ID: '19', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1' } });
  assert.equal(viaServer.agentPid, process.pid);
  assert.equal(viaServer.hostPid, process.ppid);
  assert.equal(viaServer.serverPid, SERVER);
  assert.deepEqual(viaServer.kitty, { window: '19', socket: 'unix:/tmp/kitty-1' });
  // Without a front the record is as before.
  const direct = state.record('codex', process.pid, START, 1, KITTY);
  assert.equal(direct.agentPid, process.pid);
  assert.equal(direct.serverPid, undefined);
  assert.deepEqual(direct.kitty, { window: '19', socket: 'unix:/tmp/kitty-1' });
});

test('the pane opens a session from the transcript its state names, wherever the agent keeps it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sidecar-codex-home-'));
  const transcript = join(home, 'rollout-x.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'x-1', cwd: '/work/project' } }) + '\n');
  const state: SessionState = { provider: 'codex', session: 'x-1', transcript, cwd: '/work/project', agentPid: AGENT, hostPid: 1, startedAt: 1, activeAt: 1, phase: 'idle' };
  const found = await resolveSession('x-1', '/work/project', [state]);
  assert.equal(found?.file, transcript);
  assert.equal(found?.provider, 'codex');
  assert.equal(await resolveSession('x-2', join(home, 'nowhere'), [state]), undefined);
});
