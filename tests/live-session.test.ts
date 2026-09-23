import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openLiveSession, type LiveUpdate } from '../packages/core/src/live-session';
import type { Provider, SessionCandidate } from '../packages/core/src/model';
import { parseCodex } from '../packages/core/src/codex';
import { parseClaude } from '../packages/core/src/claude';

const jsonl = (records: unknown[]) => records.map(value => JSON.stringify(value)).join('\n') + '\n';
const event = (payload: unknown) => ({ type: 'event_msg', payload });
const response = (payload: unknown) => ({ type: 'response_item', payload });
const message = (text: string) => response({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }] });
async function fixture(t: { after(fn: () => Promise<void>): void }, provider: Provider = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-live-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const file = join(root, 'session.jsonl');
  const meta = provider === 'codex' ? { type: 'session_meta', payload: { id: 's', cwd: projectPath } }
    : { type: 'user', uuid: 'request', sessionId: 's', cwd: projectPath, message: { role: 'user', content: 'Question' } };
  const records: unknown[] = [meta]; await writeFile(file, jsonl(records));
  const candidate: SessionCandidate = { id: 's', provider, projectPath, file, updatedAt: 0, activity: 'unverified' };
  const live = await openLiveSession(candidate, { pollMs: 25 }); t.after(() => live.close());
  return { file, candidate, records, live, async append(...values: unknown[]) { records.push(...values); await appendFile(file, jsonl(values)); } };
}

test('Codex live parser emits calls before results and updates the same identity without EOF', async t => {
  const f = await fixture(t); const updates: LiveUpdate[] = [];
  f.live.start(update => updates.push(update));
  await f.append(event({ type: 'task_started', turn_id: 't1' }), message('Reading **files**'),
    response({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"pwd"}' }));
  await f.live.poll();
  const call = f.live.session.items.find(item => item.kind === 'tool')!;
  assert.ok(call); assert.equal(call.result, 'not-observed');
  const frozen = structuredClone(call);
  await f.append(event({ type: 'task_complete', turn_id: 't1' }), event({ type: 'task_started', turn_id: 't2' }), message('New turn'),
    response({ type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 0\nOutput:\n/project' }));
  await f.live.poll();
  assert.equal(f.live.session.items.filter(item => item.kind === 'tool').length, 1);
  assert.equal(f.live.session.items.find(item => item.id === call.id), call);
  assert.equal(call.turnId, 't1'); assert.equal(call.result, 'readable');
  assert.equal(frozen.result, 'not-observed');
  assert.deepEqual(f.live.session, parseCodex({ file: f.file, projectPath: f.candidate.projectPath, text: jsonl(f.records) }));
  assert.ok(updates.length >= 2); assert.equal(f.live.health.state, 'observing');
});

test('Claude live parser retains tool/result linkage and title metadata between polls', async t => {
  const f = await fixture(t, 'claude');
  await f.append({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [
    { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/fixture/a' } }] } });
  await f.live.poll();
  const call = f.live.session.items.find(item => item.kind === 'tool')!;
  assert.equal(call.result, 'not-observed');
  await f.append({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'File contents' }] } },
    { type: 'ai-title', sessionId: 's', aiTitle: 'Named session' });
  await f.live.poll();
  assert.equal(call.result, 'readable'); assert.equal(f.live.session.title, 'Named session');
  assert.deepEqual(f.live.session, parseClaude({ file: f.file, projectPath: f.candidate.projectPath, text: jsonl(f.records) }));
});

test('partial bytes are health only; later completion emits one item and idle polls do not notify', async t => {
  const f = await fixture(t); const updates: LiveUpdate[] = [];
  f.live.start(update => updates.push(update)); await f.live.poll(); assert.equal(updates.length, 0);
  const row = JSON.stringify(message('半行🙂'));
  await appendFile(f.file, row.slice(0, -3)); await f.live.poll();
  assert.equal(updates.at(-1)?.contentChanged, false); assert.ok(f.live.health.pendingBytes > 0);
  assert.equal(f.live.session.items.length, 0);
  await appendFile(f.file, row.slice(-3) + '\n'); await f.live.poll();
  assert.equal(f.live.session.items.filter(item => item.kind === 'message').length, 1);
  const count = updates.length; await f.live.poll(); assert.equal(updates.length, count);
});

test('a replaced source pauses with retained content and never reads the replacement', async t => {
  const f = await fixture(t); const updates: LiveUpdate[] = [];
  f.live.start(update => updates.push(update));
  await f.append(message('Original')); await f.live.poll();
  await rename(f.file, f.file + '.old'); await writeFile(f.file, jsonl([...f.records, message('Replacement')]));
  await f.live.poll();
  assert.equal(f.live.health.state, 'paused'); assert.equal(f.live.health.reason, 'source-changed');
  assert.ok(!JSON.stringify(f.live.session).includes('Replacement'));
  const count = updates.length; await f.live.poll(); assert.equal(updates.length, count);
});

test('automatic polling works and closing cancels subsequent delivery', async t => {
  const f = await fixture(t);
  let seen = 0; f.live.start(() => { seen++; });
  await f.append(message('Automatic'));
  for (let i = 0; i < 100 && !seen; i++) await delay(10);
  assert.equal(seen, 1);
  await f.live.close(); await f.append(message('After close')); await f.live.poll(); await delay(60);
  assert.equal(seen, 1);
});

test('a write to the source is read at once, without waiting for the poll interval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-live-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const file = join(root, 'session.jsonl');
  await writeFile(file, jsonl([{ type: 'session_meta', payload: { id: 's', cwd: projectPath } }]));
  // A ten-second poll: anything faster than that came through the file watcher.
  const live = await openLiveSession({ id: 's', provider: 'codex', projectPath, file, updatedAt: 0, activity: 'unverified' }, { pollMs: 10000 });
  t.after(() => live.close());
  let seenAt = 0; live.start(() => { seenAt ||= Date.now(); });
  const writtenAt = Date.now();
  await appendFile(file, jsonl([message('Watched')]));
  for (let i = 0; i < 200 && !seenAt; i++) await delay(10);
  assert.ok(seenAt, 'The append was delivered before the ten-second poll');
  assert.ok(seenAt - writtenAt < 1000, `delivered in ${seenAt - writtenAt} ms`);
  assert.ok(live.session.items.some(item => item.summary.includes('Watched')));
});

test('callback errors do not falsely pause the source; malformed complete records remain coverage gaps', async t => {
  const f = await fixture(t);
  f.live.start(() => { throw new Error('consumer'); });
  await appendFile(f.file, '{bad}\n');
  // A timer may consume the row first; explicit poll errors are caller-owned.
  await f.live.poll().catch(() => undefined);
  assert.equal(f.live.health.state, 'observing');
  assert.match(f.live.session.warnings.join(), /完整记录无法解析/);
  f.live.start(() => undefined);
  await f.append(message('Recovered')); await f.live.poll();
  assert.ok(f.live.session.items.some(item => item.summary === 'Recovered'));
});

test('an already aborted initial load cannot establish a live observer', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(openLiveSession(f.candidate, { signal: controller.signal }), /取消/);
});
