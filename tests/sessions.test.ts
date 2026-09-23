import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDirectory, discoverSessions, loadSession, sessionKey } from '../packages/core/src/sessions';

test('discovery scopes both providers by verified project identity, not newest file or entry point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-discovery-test-'));
  try {
    const project = join(root, 'project');
    const codex = join(root, 'codex');
    const claude = join(root, 'claude');
    const claudeDir = join(claude, claudeProjectDirectory(project));
    await Promise.all([mkdir(project), mkdir(codex), mkdir(claudeDir, { recursive: true })]);
    const jsonl = (values: unknown[]) => values.map(x => JSON.stringify(x)).join('\n') + '\n';
    const codexFile = join(codex, 'terminal.jsonl');
    await writeFile(codexFile, jsonl([{ type: 'session_meta', payload: { id: 'cx-terminal', cwd: project, source: 'cli' } }]));
    await writeFile(join(codex, 'other.jsonl'), jsonl([{ type: 'session_meta', payload: { id: 'foreign', cwd: join(root, 'other'), source: 'vscode' } }]));
    await writeFile(join(claudeDir, 'cl.jsonl'), jsonl([{ type: 'user', sessionId: 'cl-main', cwd: project, message: { role: 'user', content: 'A fixture question' } }]));
    await writeFile(join(claudeDir, 'collision.jsonl'), jsonl([{ type: 'user', sessionId: 'collision', cwd: `${project}-different`, message: { content: 'Never in scope' } }]));
    const result = await discoverSessions({ projectPath: project, codexRoot: codex, claudeRoot: claude });
    assert.deepEqual(result.candidates.map(sessionKey).sort(), ['claude:cl-main', 'codex:cx-terminal']);
    assert.ok(result.candidates.every(x => x.activity === 'unverified'));
    const selected = result.candidates.find(x => x.provider === 'codex')!;
    assert.equal((await loadSession(selected)).id, 'cx-terminal');
    await writeFile(codexFile, jsonl([{ type: 'session_meta', payload: { id: 'different-session', cwd: project } }]));
    await assert.rejects(loadSession(selected), /身份/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing source directories do not manufacture a session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-empty-test-'));
  try { assert.equal((await discoverSessions({ projectPath: root, codexRoot: join(root, 'absent'), claudeRoot: join(root, 'absent2') })).candidates.length, 0); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit Codex subagent logs are excluded while normal forked sessions retain their own identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-session-granularity-test-'));
  try {
    const project = join(root, 'project'); const codex = join(root, 'codex');
    await Promise.all([mkdir(project), mkdir(codex)]);
    const jsonl = (values: unknown[]) => values.map(x => JSON.stringify(x)).join('\n') + '\n';
    const meta = (id: string, extra = {}) => ({ type: 'session_meta', payload: { id, cwd: project, ...extra } });
    const childFile = join(codex, 'child.jsonl');
    await writeFile(childFile, jsonl([
      meta('child-session', { source: { subagent: { thread_spawn: { parent_thread_id: 'parent-session' } } } }),
      meta('parent-session', { source: 'vscode' })
    ]));
    await writeFile(join(codex, 'normal-fork.jsonl'), jsonl([
      meta('normal-fork', { source: 'vscode', forked_from_id: 'parent-session' }),
      meta('parent-session', { source: 'vscode' }),
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A request' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Another request' }] } }
    ]));
    const result = await discoverSessions({ projectPath: project, codexRoot: codex, claudeRoot: join(root, 'absent') });
    assert.deepEqual(result.candidates.map(sessionKey), ['codex:normal-fork']);
    const loaded = await loadSession(result.candidates[0]);
    assert.equal(loaded.id, 'normal-fork');
    assert.deepEqual(loaded.items.filter(item => item.kind === 'request').map(item => item.turnId), ['turn-a', 'turn-b']);
    await assert.rejects(loadSession({ id: 'child-session', provider: 'codex', file: childFile, projectPath: project, updatedAt: 0, activity: 'unverified' }), /子 Agent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
