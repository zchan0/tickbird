import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SessionData, TimelineItem } from '../packages/core/src/model';
import { groupSessionTurns } from '../packages/core/src/timeline';

const item = (id: string, turnId?: string, kind: TimelineItem['kind'] = 'tool'): TimelineItem => ({
  id, sessionId: 'session', turnId, kind, title: id, summary: id, status: 'info', availability: 'none', sources: [{ file: '/log', line: 1 }],
});
const session = (items: TimelineItem[]): SessionData => ({ id: 'session', title: 'first request', provider: 'codex', projectPath: '/project', items, coverage: [], warnings: [] });

test('a session contains distinct turns without duplicating, relabeling or dropping observations', () => {
  const data = session([item('question-1', 't1', 'request'), item('tool-1', 't1'), item('question-2', 't2', 'request'), item('tool-2', 't2'), item('late-1', 't1')]);
  const before = JSON.stringify(data);
  const groups = groupSessionTurns(data);
  assert.deepEqual(groups.map(group => [group.turnId, group.ordinal, group.request, group.items.map(value => value.id)]), [
    ['t1', 1, 'question-1', ['question-1', 'tool-1', 'late-1']], ['t2', 2, 'question-2', ['question-2', 'tool-2']],
  ]);
  assert.equal(JSON.stringify(data), before);
  assert.equal(new Set(groups.flatMap(group => group.items.map(value => value.id))).size, data.items.length);
});

test('missing turn identity is not guessed from user text or combined across known turns', () => {
  const groups = groupSessionTurns(session([item('unknown-1', undefined, 'request'), item('known', 't1'), item('unknown-2'), item('unknown-3')]));
  assert.deepEqual(groups.map(group => [group.turnId, group.ordinal, group.items.length]), [[undefined, undefined, 1], ['t1', 1, 1], [undefined, undefined, 2]]);
  assert.equal(groups[0].key, 'unassigned:unknown-1');
  assert.equal(groups[2].key, 'unassigned:unknown-2');
});

test('mixed session observations cannot be presented under the selected session', () => {
  assert.throws(() => groupSessionTurns(session([{ ...item('foreign', 't1'), sessionId: 'another-session' }])), /不属于当前 session/);
});
