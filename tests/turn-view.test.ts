import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';
import { visibleTurnGroups } from '../packages/core/src/outline';
import type { ChapterRow } from '../packages/core/src/chapters';
import { duration, elapsed, outcomeWord, publicBody, rowView, runStarts, turnView } from '../packages/core/src/turn-view';
import { setLanguage } from '../packages/core/src/i18n';

// Written for the Chinese pages: their words are checked as they read in Chinese.
setLanguage('zh');

const parse = (records: unknown[]) => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
const at = (second: number) => new Date(Date.UTC(2026, 9, 5, 1, 0, second)).toISOString();
let uuid = 0;
const row = (type: string, content: unknown, second: number, extra = {}) => ({ type, uuid: `u${++uuid}`, timestamp: at(second), sessionId: 'cl', cwd: '/fixture', message: { role: type, content }, ...extra });
const answer = (text: string, second: number) => ({ ...row('assistant', [], second), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const bash = (id: string, command: string, description: string, second: number) => row('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command, description } }], second);
const result = (id: string, second: number, isError = false) => row('user', [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'Exit code 2' : 'ok' }], second);

const session = parse([
  row('user', '跑测试', 0),
  row('assistant', [{ type: 'text', text: '先跑一遍。' }], 1),
  bash('t1', 'npm test', 'Run tests', 2), result('t1', 4, true),
  bash('t2', 'npm test', 'Run tests again', 5), result('t2', 6),
  answer('好了。', 7),
  { type: 'system', subtype: 'turn_duration', durationMs: 7000, uuid: 'd1', timestamp: at(8), sessionId: 'cl' },
  row('user', '再看一下', 20),
  bash('t3', 'ls', 'List files', 21),
]);
const [first, second] = visibleTurnGroups(session);

test('the agents’ own formats: short turn length, long elapsed, outcome words', () => {
  assert.equal(duration(900), '');
  assert.equal(duration(12_000), '12s');
  assert.equal(duration(180_000), '3m');
  assert.equal(elapsed(93_000), '1m 33s');
  assert.equal(elapsed(3_725_000), '1h 2m 5s');
  assert.equal(outcomeWord({ kind: 'failed', exitCode: 1 }), 'exit 1');
  assert.equal(outcomeWord({ kind: 'failed' }), 'failed');
  assert.equal(outcomeWord({ kind: 'denied', denial: 'user-rejected' }), 'rejected');
  assert.equal(outcomeWord({ kind: 'interrupted' }), 'interrupted');
});

test('an ended turn splits into its process and the closing answer, with the done line and call count', () => {
  const view = turnView(first, false, 'claude');
  assert.equal(view.label, '第 1 轮');
  assert.equal(view.live, false);
  assert.deepEqual(view.answers.map(segment => segment.kind), ['answer']);
  assert.ok(view.process.length > 0 && view.process.every(segment => segment.kind !== 'answer'));
  assert.equal(view.calls, 2);
  assert.match(view.done, /^\w+ for 7s$/);
  assert.equal(view.toolWidth, 4);
  assert.equal(turnView(first, false, 'codex').done, 'Worked for 7s');
});

test('only the newest unclosed turn is live, and its status word stays put for the turn', () => {
  const live = turnView(second, true, 'claude');
  assert.equal(live.live, true);
  assert.equal(turnView(second, false, 'claude').live, false);
  assert.equal(live.verb, turnView(second, true, 'claude').verb);
  assert.match(live.verb, /…$/);
  assert.equal(turnView(second, true, 'codex').verb, 'Working');
});

test('a row says its outcome, and a live call without a return is still out', () => {
  const rows = turnView(first, false, 'claude').rows;
  const failed = rowView(rows[0], false);
  assert.equal(failed.tool, 'Bash');
  assert.equal(failed.word, 'exit 2');
  assert.equal(rowView(rows[1], false).word, '');
  const pending = turnView(second, true, 'claude').rows[0];
  assert.equal(rowView(pending, true).out, true);
  assert.equal(rowView(pending, false).out, false);
});

test('a question shows its chosen answers; the header only when it asked more than one', () => {
  const base: ChapterRow = { id: 'q', tool: 'Ask', label: '仓库设为？', count: 1, items: [], running: false, pending: true, output: false, openable: false };
  const one = rowView({ ...base, choices: [{ header: 'Repo', question: '仓库设为？', options: ['私有', '公开'], chosen: [] }] }, true);
  assert.deepEqual(one.choices, [{ chosen: [], waiting: true }]);
  const two = rowView({ ...base, pending: false, choices: [
    { header: 'Repo', question: 'a', options: ['私有'], chosen: ['私有'] },
    { header: 'Push', question: 'b', options: ['是'], chosen: [] },
  ] }, true);
  assert.deepEqual(two.choices, [{ header: 'Repo', chosen: ['私有'], waiting: false }, { header: 'Push', chosen: [], waiting: false }]);
});

test('a tool name starts a run once; a shared output starts its own run', () => {
  const make = (tool: string, output = false) => ({ tool, output } as ChapterRow);
  assert.deepEqual(runStarts([make('Bash'), make('Bash'), make('Read'), make('Bash'), make('Bash', true)]), [true, false, true, true, true]);
});

test('public body is the item’s own words, falling back to its summary', () => {
  const request = first.items.find(item => item.kind === 'request')!;
  assert.equal(publicBody(request), '跑测试');
  assert.equal(publicBody({ ...request, detail: undefined, summary: '摘要' }), '摘要');
});
