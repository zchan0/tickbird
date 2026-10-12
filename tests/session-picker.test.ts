import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionCandidate } from '../packages/core/src/model';
import { createSessionPickerMetadata } from '../packages/core/src/session-picker';
import { tempDir } from './temp';

const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = tempDir('picker-metadata');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  const write = async (id: string, records: unknown[] = [], options: { provider?: 'codex' | 'claude'; cwd?: string; source?: unknown } = {}): Promise<SessionCandidate> => {
    const provider = options.provider ?? 'codex';
    const file = join(directory, `${id}.jsonl`);
    const identity = provider === 'codex'
      ? { type: 'session_meta', payload: { id, cwd: options.cwd ?? project, source: options.source ?? 'cli' } }
      : { type: 'user', uuid: `${id}-initial`, sessionId: id, cwd: options.cwd ?? project,
        message: { role: 'user', content: '最初的问题' } };
    await writeFile(file, jsonl([identity, ...records]));
    return { id, provider, file, projectPath: project, updatedAt: (await stat(file)).mtimeMs, activity: 'unverified' };
  };
  return { directory, project, write };
}
const cxUser = (message: string) => ({ type: 'event_msg', payload: { type: 'user_message', message } });
const cxAssistant = (text: string) => ({ type: 'response_item', payload: {
  type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }],
} });

test('picker metadata uses verified session title, honest log time and latest public conversation, not trailing tool records', async t => {
  const { write } = await fixture(t);
  const candidate = await write('codex-main', [cxUser('核对选择器'), cxAssistant('已完成可读性检查。'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'tool', name: 'exec_command', arguments: '{"cmd":"private-tool-marker"}' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } },
  ]);
  const before = await readFile(candidate.file, 'utf8');
  const entry = await createSessionPickerMetadata().read(candidate);
  assert.equal(entry.key, 'codex:codex-main');
  assert.equal(entry.title, '核对选择器');
  assert.equal(entry.providerLabel, 'Codex');
  assert.equal(entry.shortId, 'codex-ma');
  assert.equal(entry.latestRole, 'assistant');
  assert.equal(entry.latestText, 'Agent：已完成可读性检查。');
  assert.equal(entry.metadataStatus, 'ready');
  assert.match(entry.updatedLabel, /^日志更新 /);
  assert.equal(entry.updatedAt, candidate.updatedAt);
  assert.ok(!JSON.stringify(entry).includes('private-tool-marker'));
  assert.ok(!JSON.stringify(entry).includes('活跃'));
  assert.equal(await readFile(candidate.file, 'utf8'), before, 'Metadata inspection is read-only');
});

test('Claude saved title and latest revised message are used without exposing title metadata or older user text as the latest content', async t => {
  const { project, write } = await fixture(t);
  const common = { sessionId: 'claude-main', cwd: project };
  const candidate = await write('claude-main', [
    { ...common, type: 'assistant', uuid: 'assistant-first', message: { id: 'same-message', role: 'assistant', content: [{ type: 'text', text: '旧的公开说明' }] } },
    { ...common, type: 'user', uuid: 'user-later', message: { role: 'user', content: '后来的问题' } },
    { ...common, type: 'assistant', uuid: 'assistant-revision', message: { id: 'same-message', role: 'assistant', content: [{ type: 'text', text: '最后修订的公开说明' }] } },
    { ...common, type: 'ai-title', aiTitle: '已经保存的会话标题' },
    { ...common, type: 'assistant', uuid: 'tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'tool-only-file' } }] } },
  ], { provider: 'claude' });
  const entry = await createSessionPickerMetadata().read(candidate);
  assert.equal(entry.title, '已经保存的会话标题');
  assert.equal(entry.providerLabel, 'Claude Code');
  assert.equal(entry.latestText, 'Agent：最后修订的公开说明');
  assert.ok(!entry.latestText.includes('后来的问题'));
  assert.ok(!JSON.stringify(entry).includes('tool-only-file'));
});

test('latest user request omits attached IDE context and neutralizes codicons/control characters', async t => {
  const { write } = await fixture(t);
  const candidate = await write('plain-request', [cxUser('$(zap) 名称\n第一行'),
    cxUser('# Context from my IDE setup:\n- unrelated-context-marker\n## My request:\n$(warning) 真正的问题\u001b\n请核对\u202e文字'),
  ]);
  const entry = await createSessionPickerMetadata().read(candidate);
  assert.equal(entry.title, '＄(zap) 名称 第一行');
  assert.equal(entry.latestRole, 'user');
  assert.equal(entry.latestText, '用户：＄(warning) 真正的问题 请核对 文字');
  assert.ok(!JSON.stringify(entry).includes('unrelated-context-marker'));
  assert.ok(!entry.latestText.includes('$('));
});

test('empty public conversation is explicit and snippets remain bounded', async t => {
  const { write } = await fixture(t);
  const empty = await write('empty', [{ type: 'turn_context', payload: { turn_id: 'one' } }]);
  const loader = createSessionPickerMetadata();
  const metadata = await loader.read(empty);
  assert.equal(metadata.metadataStatus, 'ready');
  assert.equal(metadata.latestText, undefined);
  assert.match(metadata.reason!, /未取得.*公开对话正文/);
  const long = await write('long', [cxUser('用户请求'), cxAssistant('很长的公开说明'.repeat(100))]);
  const entry = await loader.read(long);
  assert.ok(entry.latestText!.length <= 157);
  assert.ok(entry.latestText!.endsWith('…'));
});

test('eager metadata is bounded while every candidate remains available for lazy enrichment', async t => {
  const { write } = await fixture(t);
  const candidates = await Promise.all(['one', 'two', 'three'].map(id => write(id, [cxUser(`请求 ${id}`)])));
  const loader = createSessionPickerMetadata({ maxEagerSessions: 1 });
  const entries = await loader.list(candidates);
  assert.deepEqual(entries.map(entry => entry.key), candidates.map(candidate => `codex:${candidate.id}`));
  assert.deepEqual(entries.map(entry => entry.metadataStatus), ['ready', 'deferred', 'deferred']);
  const lazy = await loader.read(candidates[2]);
  assert.equal(lazy.metadataStatus, 'ready');
  assert.equal(lazy.latestText, '用户：请求 three');
  const bytes = await createSessionPickerMetadata({ maxEagerBytes: 1 }).list(candidates);
  assert.ok(bytes.every(entry => entry.metadataStatus === 'deferred'));
  assert.ok(bytes.every(entry => /^日志更新 /.test(entry.updatedLabel)));
  const disabled = await createSessionPickerMetadata({ maxEagerSessions: 0 }).list(candidates);
  assert.ok(disabled.every(entry => entry.metadataStatus === 'deferred'));
});

test('metadata promises are memoized only within one picker opening and source changes never rename to another session', async t => {
  const { write, project } = await fixture(t);
  const candidate = await write('original', [cxUser('原来的问题')]);
  const loader = createSessionPickerMetadata();
  const first = loader.read(candidate);
  assert.equal(loader.read(candidate), first, 'Concurrent eager and active-item reads share one validated load');
  assert.equal((await first).title, '原来的问题');
  await writeFile(candidate.file, jsonl([{ type: 'session_meta', payload: { id: 'replaced', cwd: project } }, cxUser('replacement-secret-marker')]));
  assert.equal((await loader.read(candidate)).title, '原来的问题', 'One opening retains a metadata snapshot, not a persistent cache');
  const fresh = await createSessionPickerMetadata().read(candidate);
  assert.equal(fresh.metadataStatus, 'unavailable');
  assert.ok(!JSON.stringify(fresh).includes('replacement-secret-marker'));
  assert.ok(!JSON.stringify(fresh).includes(candidate.file));
});

test('identity, project, child-session and symlink failures use short non-leaking fallbacks', async t => {
  const { directory, write } = await fixture(t);
  const valid = await write('valid', [cxUser('readable-current-project')]);
  const foreign = await write('foreign', [cxUser('foreign-secret-marker')], { cwd: join(directory, 'other') });
  const child = await write('child', [cxUser('child-secret-marker')], { source: { subagent: { thread_spawn: { parent_thread_id: 'valid' } } } });
  const linked = join(directory, 'linked.jsonl');
  await symlink(valid.file, linked);
  const loader = createSessionPickerMetadata();
  const good = await loader.read(valid);
  assert.equal(good.metadataStatus, 'ready');
  for (const candidate of [foreign, child, { ...valid, file: linked }, { ...valid, id: 'mismatched' }, { ...valid, file: foreign.file }]) {
    const entry = await loader.read(candidate);
    assert.equal(entry.metadataStatus, 'unavailable');
    assert.equal(entry.reason, '暂时无法核对会话内容');
    assert.ok(!entry.latestText);
    assert.ok(!JSON.stringify(entry).includes('secret-marker'));
    assert.ok(!JSON.stringify(entry).includes(directory));
  }
});

test('base entries do not invent timestamps or an active-session claim', () => {
  const candidate: SessionCandidate = { id: '$(zap)\u0000x', provider: 'codex', file: '/not-read', projectPath: '/not-read', updatedAt: Number.NaN, activity: 'unverified' };
  const entry = createSessionPickerMetadata().base(candidate);
  assert.equal(entry.updatedLabel, '日志更新时间未知');
  assert.equal(entry.metadataStatus, 'deferred');
  assert.ok(!entry.title.includes('$('));
  assert.ok(!entry.title.includes('\u0000'));
  assert.ok(!entry.shortId.includes('$('));
  assert.ok(!entry.shortId.includes('\u0000'));
  assert.equal(entry.latestText, undefined);
});
