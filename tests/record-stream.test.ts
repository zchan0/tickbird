import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, open, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, SessionCandidate } from '../packages/core/src/model';
import { JsonlFramer, SessionRecordCursor, SourceChangedError, type RecordFrame } from '../packages/core/src/record-stream';
import { observeRecord } from '../packages/core/src/record-observation';

const jsonl = (value: unknown) => JSON.stringify(value) + '\n';
async function fixture(t: { after(fn: () => Promise<void>): void }, provider: Provider = 'codex', suffix = '') {
  const root = await mkdtemp(join(tmpdir(), 'sidecar-record-stream-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const file = join(root, 'session.jsonl');
  const meta = provider === 'codex' ? { type: 'session_meta', payload: { id: 'session-a', cwd: project, source: 'fixture' } }
    : { type: 'user', sessionId: 'session-a', cwd: project, uuid: 'request-a', message: { role: 'user', content: 'fixture' } };
  await writeFile(file, jsonl(meta) + suffix);
  const candidate: SessionCandidate = { id: 'session-a', provider, file, projectPath: project, updatedAt: 0, activity: 'unverified' };
  const start = async () => { const cursor = await SessionRecordCursor.open(candidate); t.after(() => cursor.close()); return cursor; };
  return { root, project, file, candidate, meta, start };
}

async function drain(cursor: SessionRecordCursor, budget?: number): Promise<RecordFrame[]> {
  const result: RecordFrame[] = [];
  for (;;) { const batch = await cursor.read(budget); result.push(...batch.records); if (batch.caughtUp) return result; }
}

test('framer preserves UTF-8, CRLF, source byte ranges and line identity at every split', () => {
  const bytes = Buffer.from('{"text":"中文🙂"}\r\n\n{"id":2}\n');
  for (let split = 0; split <= bytes.length; split++) {
    const framer = new JsonlFramer();
    const rows = [...framer.push(bytes.subarray(0, split)), ...framer.push(bytes.subarray(split))];
    assert.deepEqual(rows.map(r => r.kind), ['json', 'empty', 'json']);
    assert.deepEqual(rows[0].value, { text: '中文🙂' });
    assert.equal(rows[0].byteEnd, bytes.indexOf(10) + 1);
    assert.equal(rows[2].byteEnd, bytes.length); assert.equal(rows[2].line, 3);
    assert.equal(framer.pendingBytes, 0);
  }
});

test('temporary EOF never parses incomplete JSON and later completion is emitted once', () => {
  const f = new JsonlFramer();
  assert.deepEqual(f.push(Buffer.from('{"text":"hello')), []);
  assert.equal(f.pendingBytes, 14);
  assert.deepEqual(f.push(Buffer.alloc(0)), []);
  const [row] = f.push(Buffer.from('"}\n'));
  assert.equal(row.kind, 'json'); assert.deepEqual(row.value, { text: 'hello' });
  assert.deepEqual(f.push(Buffer.alloc(0)), []);
});

test('malformed, invalid UTF-8 and over-budget rows have explicit gaps and subsequent rows recover', () => {
  const f = new JsonlFramer(32);
  assert.deepEqual(f.push(Buffer.alloc(64, 120)), []);
  assert.equal(f.bufferedBytes, 0); assert.equal(f.pendingBytes, 64);
  const rows = f.push(Buffer.concat([Buffer.from('\n{bad}\n'), Buffer.from([255, 10]), Buffer.from('{"ok":true}\n')]));
  assert.deepEqual(rows.map(r => r.kind), ['oversized', 'invalid-json', 'invalid-utf8', 'json']);
  assert.ok(rows.slice(0, 3).every(r => r.value === undefined));
  assert.equal(rows[3].line, 4); assert.deepEqual(rows[3].value, { ok: true });
});

test('one-byte chunks of a long row keep the same decoded content without fragment accumulation', () => {
  const f = new JsonlFramer(64000); const value = { value: '中'.repeat(12000) };
  const bytes = Buffer.from(jsonl(value)); const rows: RecordFrame[] = [];
  for (const byte of bytes) rows.push(...f.push(Buffer.from([byte])));
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].value, value); assert.equal(f.bufferedBytes, 0);
});

test('identical JSON at distinct source positions is retained, not content-deduplicated', () => {
  const rows = new JsonlFramer().push(Buffer.from(jsonl({ same: true }).repeat(2)));
  assert.equal(rows.length, 2); assert.deepEqual(rows[0].value, rows[1].value);
  assert.equal(rows[0].byteEnd, rows[1].byteStart); assert.notEqual(rows[0].line, rows[1].line);
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: verified history, no-change polls, partial append and ordered completion`, async t => {
    const f = await fixture(t, provider); const cursor = await f.start();
    const history = await drain(cursor, 7); assert.equal(history.length, 1);
    assert.deepEqual((await cursor.read()).records, []);
    await appendFile(f.file, '{"value":"半');
    const partial = await cursor.read(); assert.equal(partial.records.length, 0); assert.ok(partial.pendingBytes > 0);
    await appendFile(f.file, '行"}\n{"value":"next"}\n');
    const next = await cursor.read(); assert.deepEqual(next.records.map(r => r.value), [{ value: '半行' }, { value: 'next' }]);
    assert.deepEqual(next.records.map(r => r.line), [2, 3]); assert.equal(next.pendingBytes, 0);
    assert.ok(next.previousCheckAt); assert.ok(next.previousCheckAt! <= next.observedAt);
    assert.equal((await cursor.read()).records.length, 0);
  });
}

test('append during catch-up is not discarded as a changing whole-file snapshot', async t => {
  const f = await fixture(t, 'codex', jsonl({ id: 1 }) + jsonl({ id: 2 })); const cursor = await f.start();
  const first = await cursor.read(12); assert.equal(first.caughtUp, false);
  await appendFile(f.file, jsonl({ id: 3 }));
  const rows = [...first.records, ...await drain(cursor, 12)];
  assert.deepEqual(rows.slice(1).map(r => r.value), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(rows.map(r => r.line), [1, 2, 3, 4]);
});

test('rotation stops the old cursor and never silently binds the new identity', async t => {
  const f = await fixture(t); const cursor = await f.start(); await drain(cursor);
  await rename(f.file, join(f.root, 'old.jsonl'));
  await writeFile(f.file, jsonl({ type: 'session_meta', payload: { id: 'different', cwd: f.project } }));
  await assert.rejects(cursor.read(), SourceChangedError);
  await assert.rejects(cursor.read(), /重新核验/);
  await assert.rejects(SessionRecordCursor.open(f.candidate), /身份/);
});

test('same-identity replacement still starts a new generation only by explicit reopen', async t => {
  const f = await fixture(t); const old = await f.start(); await drain(old);
  await rename(f.file, join(f.root, 'old.jsonl')); await writeFile(f.file, jsonl(f.meta));
  await assert.rejects(old.read(), SourceChangedError);
  const next = await f.start(); assert.equal((await drain(next))[0].line, 1);
});

test('truncation is detected even when the new size is ahead of the read cursor', async t => {
  const f = await fixture(t, 'codex', jsonl({ pad: 'x'.repeat(1000) })); const cursor = await f.start();
  await cursor.read(8); await truncate(f.file, 500);
  await assert.rejects(cursor.read(), SourceChangedError);
});

test('same-size modification fails closed rather than retaining a false live snapshot', async t => {
  const f = await fixture(t); const cursor = await f.start(); await drain(cursor);
  const future = new Date(Date.now() + 10000); await utimes(f.file, future, future);
  await assert.rejects(cursor.read(), SourceChangedError);
});

test('prefix rewrite followed by append is caught without dumping changed content', async t => {
  const f = await fixture(t); const cursor = await f.start(); await drain(cursor);
  await writeFile(f.file, jsonl({ type: 'session_meta', payload: { id: 'foreign-id', cwd: f.project } }) + jsonl({ pad: 'x'.repeat(300) }));
  await assert.rejects(cursor.read(), SourceChangedError);
});

test('trailing anchor detects an appended rewrite outside the identity prefix', async t => {
  const f = await fixture(t, 'codex', jsonl({ pad: 'x'.repeat(140000) })); const cursor = await f.start(); await drain(cursor);
  const handle = await open(f.file, 'r+');
  try { await handle.write(Buffer.from('y'), 0, 1, cursor.initialSize - 4); } finally { await handle.close(); }
  await appendFile(f.file, jsonl({ next: true }));
  await assert.rejects(cursor.read(), SourceChangedError);
});

test('foreign project, child identity, incomplete identity and symlink are rejected before observations', async t => {
  const f = await fixture(t); const foreign = join(f.root, 'foreign'); await mkdir(foreign);
  await assert.rejects(SessionRecordCursor.open({ ...f.candidate, projectPath: foreign }), /项目/);
  await writeFile(f.file, jsonl({ type: 'session_meta', payload: { id: f.candidate.id, cwd: f.project, source: { subagent: {} } } }));
  await assert.rejects(SessionRecordCursor.open(f.candidate), /身份/);
  await writeFile(f.file, JSON.stringify(f.meta));
  await assert.rejects(SessionRecordCursor.open(f.candidate), /身份/);
  const link = join(f.root, 'link.jsonl'); await symlink(f.file, link);
  await assert.rejects(SessionRecordCursor.open({ ...f.candidate, file: link }));
});

test('concurrent pulls serialize and closing suppresses queued delivery', async t => {
  const f = await fixture(t, 'codex', jsonl({ id: 1 })); const cursor = await f.start();
  const batches = await Promise.all([cursor.read(64), cursor.read(64), cursor.read(64)]);
  const rows = [...batches.flatMap(b => b.records), ...await drain(cursor)];
  assert.deepEqual(rows.map(r => r.line), [1, 2]);
  const pending = cursor.read(); const closing = cursor.close();
  await assert.rejects(pending, /关闭/); await closing;
  await assert.rejects(cursor.read(), /关闭/);
});

test('more than 64 MiB is scanned in bounded pulls and still accepts a later append', async t => {
  const f = await fixture(t);
  const chunk = jsonl({ type: 'fixture-data', value: 'x'.repeat(1000) }).repeat(256);
  const handle = await open(f.file, 'a');
  try { for (let i = 0; i < 256; i++) await handle.writeFile(chunk); } finally { await handle.close(); }
  const cursor = await f.start(); assert.ok(cursor.initialSize > 64 * 1024 * 1024);
  let rows = 0; let batch;
  do { batch = await cursor.read(); rows += batch.records.length; assert.ok(batch.records.length < 300); } while (!batch.caughtUp);
  assert.equal(rows, 256 * 256 + 1); assert.equal(batch.offset, cursor.initialSize);
  await appendFile(f.file, jsonl({ end: true }));
  assert.deepEqual((await cursor.read()).records.map(r => r.value), [{ end: true }]);
});

test('metadata projection pairs explicit calls without exposing inputs, outputs or private text', () => {
  const f = new JsonlFramer();
  const records = f.push(Buffer.from([
    { type: 'response_item', timestamp: '2026-09-07T00:00:00Z', payload: { type: 'function_call', call_id: 'source-call', name: 'functions.exec', arguments: 'SECRET_INPUT' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'source-call', output: 'SECRET_OUTPUT' } },
    { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'PRIVATE_REASONING' } },
  ].map(jsonl).join('')));
  const results = records.flatMap(r => observeRecord('codex', r));
  assert.equal(results[0].callKey, results[2].callKey);
  assert.equal(results[2].turnKey, undefined, 'No reassignment to the newest turn');
  assert.equal(results[0].toolName, 'functions.exec');
  assert.ok(!JSON.stringify(results).match(/SECRET_|PRIVATE_REASONING|source-call|new-turn/));
});

test('Claude tool result and stop records are distinguished from public text and thinking presence', () => {
  const records = new JsonlFramer().push(Buffer.from([
    { type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'SECRET' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'SECRET' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'SECRET' }], stop_reason: 'end_turn' } },
  ].map(jsonl).join('')));
  const results = records.flatMap(r => observeRecord('claude', r));
  assert.deepEqual(results.map(r => r.category), ['private-reasoning-presence', 'tool-call', 'tool-output', 'answer-text', 'assistant-stop-record']);
  assert.equal(results[1].callKey, results[2].callKey); assert.ok(!JSON.stringify(results).match(/SECRET|PRIVATE/));
});

test('unknown and hostile event-type shapes cannot select inherited names or leak payloads', () => {
  for (const type of ['__proto__', 'constructor', { toString: null }, null]) {
    const [frame] = new JsonlFramer().push(Buffer.from(jsonl({ type: 'event_msg', payload: { type, text: 'SECRET' } })));
    assert.deepEqual(observeRecord('codex', frame), [{ category: 'other-event', turnKey: undefined }]);
  }
});
