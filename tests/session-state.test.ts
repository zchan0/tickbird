import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { awaitingApproval, currentSession, foldSessionState, pendingDraft, readSessionStates, sessionStateDirectory, type SessionStateCache } from '../packages/core/src/session-state';

const live = () => true;
const lines = (...records: object[]) => records.map(record => JSON.stringify({ v: 1, ...record })).join('\n') + '\n';
const start = (t: number, extra = {}) => ({ t, e: 'start', provider: 'claude', session: 's1', transcript: '/t.jsonl', cwd: '/p', agentPid: 10, hostPid: 9, source: 'startup', ...extra });

test('a session goes idle → working → waiting → idle as its events say; display never ends a wait', () => {
  const steps: Array<[object, string]> = [
    [{ t: 2, e: 'prompt' }, 'working'],
    [{ t: 3, e: 'approval', tool: 'Write', summary: 'numbers.txt' }, 'waiting'],
    [{ t: 4, e: 'display', message: 'm1', index: 0, final: false, text: '好了' }, 'waiting'],
    [{ t: 5, e: 'stop' }, 'idle'],
  ];
  const seen: object[] = [start(1)];
  assert.equal(foldSessionState(lines(...seen), live)!.phase, 'idle');
  for (const [event, phase] of steps) {
    seen.push(event);
    const state = foldSessionState(lines(...seen), live)!;
    assert.equal(state.phase, phase, JSON.stringify(event));
  }
  const waiting = foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 3, e: 'approval', tool: 'Write', summary: 'numbers.txt' }), live)!;
  assert.deepEqual(waiting.approval, { tool: 'Write', summary: 'numbers.txt', at: 3 });
  assert.equal(foldSessionState(lines(...seen), live)!.approval, undefined);
});

test('display parts assemble in index order whatever order the background hooks wrote them', () => {
  const state = foldSessionState(lines(start(1), { t: 2, e: 'prompt' },
    { t: 5, e: 'display', message: 'm1', index: 2, final: true, text: 'C' },
    { t: 3, e: 'display', message: 'm1', index: 0, final: false, text: 'A' },
    { t: 4, e: 'display', message: 'm1', index: 1, final: false, text: 'B' }), live)!;
  assert.deepEqual(state.draft, { message: 'm1', text: 'ABC', final: true, at: 5 });
  const next = foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 3, e: 'display', message: 'm1', index: 0, final: true, text: 'A' },
    { t: 4, e: 'display', message: 'm2', index: 0, final: false, text: 'X' }), live)!;
  assert.equal(next.draft!.text, 'X', 'A new message starts a new draft');
  assert.equal(foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 3, e: 'display', message: 'm1', index: 0, final: true, text: 'A' }, { t: 4, e: 'stop' }), live)!.draft, undefined);
  // Measured with Claude Code 2.1.289: the last part's background hook can land after the turn's stop.
  const late = foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 4, e: 'stop' }, { t: 5, e: 'display', message: 'm1', index: 0, final: true, text: 'A' }), live)!;
  assert.equal(late.phase, 'idle');
  assert.equal(late.draft, undefined);
});

test('a half-written last line, a foreign format and lines before start are skipped', () => {
  const text = JSON.stringify({ v: 1, t: 0, e: 'prompt' }) + '\n' + lines(start(1), { t: 2, e: 'prompt' }) + JSON.stringify({ v: 2, t: 3, e: 'stop' }) + '\n{"v":1,"t":4,"e":"st';
  const state = foldSessionState(text, live)!;
  assert.equal(state.phase, 'working');
  assert.equal(state.startedAt, 1);
  assert.equal(foldSessionState('{"v":1,"t":1,"e":"prompt"}\n', live), undefined, 'No start, no session');
});

test('an ended session or a dead agent is ended; a compaction keeps the turn, a resume starts idle', () => {
  assert.equal(foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 3, e: 'end', reason: 'prompt_input_exit' }), live)!.phase, 'ended');
  assert.equal(foldSessionState(lines(start(1), { t: 2, e: 'prompt' }), () => false)!.phase, 'ended');
  assert.equal(foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, start(3, { source: 'compact' })), live)!.phase, 'working');
  const resumed = foldSessionState(lines(start(1), { t: 2, e: 'end' }, start(5, { source: 'resume', hostPid: 77 })), live)!;
  assert.equal(resumed.phase, 'idle');
  assert.equal(resumed.hostPid, 77, 'A resumed session belongs to the window that resumed it');
  assert.equal(resumed.startedAt, 1);
});

test('an approval is over once the transcript records anything after it', () => {
  const state = foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 10, e: 'approval', tool: 'Bash', summary: 'date' }), live)!;
  assert.equal(awaitingApproval(state), true);
  assert.equal(awaitingApproval(state, 9), true);
  assert.equal(awaitingApproval(state, 11), false);
  assert.equal(awaitingApproval(undefined), false);
});

test('a window follows its own most recently active live session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidecar-state-'));
  const write = (name: string, ...records: object[]) => writeFileSync(join(directory, name), lines(...records));
  write('claude-a.jsonl', start(1, { session: 'a', hostPid: 100 }), { t: 5, e: 'prompt' });
  write('codex-b.jsonl', start(2, { provider: 'codex', session: 'b', hostPid: 100 }), { t: 8, e: 'prompt' });
  write('claude-c.jsonl', start(3, { session: 'c', hostPid: 200 }), { t: 9, e: 'prompt' });
  write('claude-d.jsonl', start(4, { session: 'd', hostPid: 100 }), { t: 20, e: 'end' });
  write('notes.txt', start(1));
  const states = await readSessionStates(directory, live);
  assert.equal(states.length, 4);
  assert.equal(currentSession(states, 100)?.session, 'b');
  assert.equal(currentSession(states, 200)?.session, 'c');
  assert.equal(currentSession(states, 300), undefined);
  assert.deepEqual(await readSessionStates(join(directory, 'missing'), live), []);
});

// The hook runs as the agents run it: a separate node process with JSON on stdin.
const hook = resolve(__dirname, '../../integration/scripts/hook.mjs');
function run(provider: string, input: object, env: NodeJS.ProcessEnv, pid = process.pid) {
  return spawnSync(process.execPath, [hook, provider, String(pid)], { input: JSON.stringify(input), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });
}

test('the hook appends one silent line per event and records the agent’s window', () => {
  const home = mkdtempSync(join(tmpdir(), 'sidecar-hook-'));
  const env = { XDG_STATE_HOME: home, KITTY_WINDOW_ID: '19', KITTY_LISTEN_ON: 'unix:/tmp/kitty-1' };
  const events = [
    { hook_event_name: 'SessionStart', session_id: 'abc-1', transcript_path: '/t.jsonl', cwd: '/p', source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', session_id: 'abc-1', prompt: 'secret prompt text' },
    { hook_event_name: 'PermissionRequest', session_id: 'abc-1', tool_name: 'Bash', tool_input: { command: 'rm -rf build\n' + 'x'.repeat(500), description: 'clean' } },
    { hook_event_name: 'MessageDisplay', session_id: 'abc-1', message_id: 'm1', index: 0, final: true, delta: 'ok' },
    { hook_event_name: 'Stop', session_id: 'abc-1', last_assistant_message: 'ok' },
    { hook_event_name: 'SessionEnd', session_id: 'abc-1', reason: 'prompt_input_exit' },
  ];
  for (const event of events) {
    const result = run('claude', event, env);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'Nothing reaches the model');
  }
  const file = join(sessionStateDirectory({ XDG_STATE_HOME: home }), 'claude-abc-1.jsonl');
  const written = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(written.map(line => line.e), ['start', 'prompt', 'approval', 'display', 'stop', 'end']);
  assert.equal(written[0].agentPid, process.pid);
  assert.equal(written[0].hostPid, process.ppid, 'The agent’s parent is its host');
  assert.deepEqual(written[0].kitty, { window: '19', socket: 'unix:/tmp/kitty-1' });
  assert.ok(!readFileSync(file, 'utf8').includes('secret prompt text'), 'Prompts are not copied');
  assert.equal(written[2].summary.length, 200);
  assert.ok(!written[2].summary.includes('\n'));
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.equal(foldSessionState(readFileSync(file, 'utf8'), live)!.phase, 'ended');
});

test('the hook ignores what it cannot place and never fails the agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'sidecar-hook-'));
  const directory = sessionStateDirectory({ XDG_STATE_HOME: home });
  for (const [provider, input] of [
    ['claude', { hook_event_name: 'SessionStart', session_id: '../../etc/passwd' }],
    ['claude', { hook_event_name: 'PreToolUse', session_id: 'abc' }],
    ['other', { hook_event_name: 'SessionStart', session_id: 'abc' }],
  ] as const) assert.equal(run(provider, input, { XDG_STATE_HOME: home }).status, 0);
  assert.ok(!existsSync(directory) || readdirSync(directory).length === 0);
  const broken = spawnSync(process.execPath, [hook, 'claude', '1'], { input: 'not json', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: home } });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
  // An unwritable state directory is not the agent's problem either.
  writeFileSync(join(home, 'agent-sidecar'), 'a file where a directory should be');
  assert.equal(run('claude', { hook_event_name: 'SessionStart', session_id: 'abc' }, { XDG_STATE_HOME: home }).status, 0);
});

test('only a start opens a session file; an end without a start leaves nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'sidecar-hook-'));
  const directory = sessionStateDirectory({ XDG_STATE_HOME: home });
  // Codex quits before its first message: SessionEnd with no SessionStart.
  run('codex', { hook_event_name: 'SessionEnd', session_id: 'never-started', reason: 'other' }, { XDG_STATE_HOME: home });
  run('codex', { hook_event_name: 'UserPromptSubmit', session_id: 'never-started' }, { XDG_STATE_HOME: home });
  assert.ok(!existsSync(directory) || readdirSync(directory).length === 0);
});

test('a new session prunes week-old files of dead agents and keeps live ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'sidecar-hook-'));
  const directory = sessionStateDirectory({ XDG_STATE_HOME: home });
  run('claude', { hook_event_name: 'SessionStart', session_id: 'first' }, { XDG_STATE_HOME: home });
  const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  writeFileSync(join(directory, 'claude-dead.jsonl'), lines(start(1, { session: 'dead', agentPid: 999999 })));
  writeFileSync(join(directory, 'claude-alive.jsonl'), lines(start(1, { session: 'alive', agentPid: process.pid })));
  writeFileSync(join(directory, 'claude-recent.jsonl'), lines(start(1, { session: 'recent', agentPid: 999999 })));
  utimesSync(join(directory, 'claude-dead.jsonl'), old, old);
  utimesSync(join(directory, 'claude-alive.jsonl'), old, old);
  run('claude', { hook_event_name: 'SessionStart', session_id: 'second' }, { XDG_STATE_HOME: home });
  assert.deepEqual(readdirSync(directory).sort(), ['claude-alive.jsonl', 'claude-first.jsonl', 'claude-recent.jsonl', 'claude-second.jsonl']);
});

test('a draft shows until the transcript holds the same words, and never once idle', () => {
  const state = foldSessionState(lines(start(1), { t: 2, e: 'prompt' }, { t: 3, e: 'display', message: 'm1', index: 0, final: false, text: '1. **同时处理多个任务**：你可以一边' }), live)!;
  assert.equal(pendingDraft(state, []), '1. **同时处理多个任务**：你可以一边');
  assert.equal(pendingDraft(state, ['先看一下。']), '1. **同时处理多个任务**：你可以一边');
  assert.equal(pendingDraft(state, ['1. **同时处理多个任务**：你可以一边编辑代码，一边看测试输出。\n2. …']), undefined);
  assert.equal(pendingDraft({ ...state, phase: 'idle' }, []), undefined);
  assert.equal(pendingDraft(undefined, []), undefined);
});

test('a cached read skips unchanged files but still notices a dead agent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidecar-state-'));
  writeFileSync(join(directory, 'claude-a.jsonl'), lines(start(1, { session: 'a', agentPid: 4242 }), { t: 2, e: 'prompt' }));
  const cache: SessionStateCache = new Map();
  let alive = true;
  assert.equal((await readSessionStates(directory, () => alive, cache))[0].phase, 'working');
  const cached = cache.get('claude-a.jsonl')!;
  alive = false;
  assert.equal((await readSessionStates(directory, () => alive, cache))[0].phase, 'ended');
  assert.equal(cache.get('claude-a.jsonl'), cached, 'The unchanged file was not folded again');
  assert.equal(cached.state!.phase, 'working', 'The cached fold was not changed in place');
});
