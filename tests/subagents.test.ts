import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeSubagents, type SubagentCache } from '../packages/core/src/subagents';
import { visibleTurnGroups } from '../packages/core/src/outline';
import { tempDir } from './temp';
import { agentGroup } from '../packages/core/src/agent-line';

const line = (record: unknown) => JSON.stringify(record) + '\n';
const rec = (type: string, content: unknown, extra = {}) => line({ type, uuid: `u${Math.random()}`, timestamp: '2026-10-12T03:00:00.000Z', sessionId: 's1', cwd: '/fixture', isSidechain: true, message: { role: type, content }, ...extra });

test('a subagent\'s own record is found by the call that started it, and read again only when it changes', async () => {
  const root = tempDir('subagents');
  const transcript = join(root, 's1.jsonl');
  writeFileSync(transcript, '');
  const directory = join(root, 's1', 'subagents');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'agent-x.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Brainstorm', toolUseId: 'toolu_a1' }));
  writeFileSync(join(directory, 'agent-x.jsonl'), rec('user', 'Think of names.') + rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm view x', description: 'Check npm' } }]));
  // A meta file with no record yet, and one naming no call: neither is a subagent.
  writeFileSync(join(directory, 'agent-y.meta.json'), JSON.stringify({ toolUseId: 'toolu_a2' }));
  writeFileSync(join(directory, 'agent-z.meta.json'), JSON.stringify({ description: 'no call' }));
  writeFileSync(join(directory, 'agent-z.jsonl'), rec('user', 'x'));

  const cache: SubagentCache = new Map();
  let read = await readClaudeSubagents({ id: 's1', projectPath: '/fixture' }, transcript, cache);
  assert.deepEqual([...read.byCall.keys()], ['toolu_a1']);
  assert.equal(read.changed, true);
  const groups = visibleTurnGroups(read.byCall.get('toolu_a1')!.session);
  assert.equal(groups.length, 1, 'A subagent is one turn: its task, then its work');
  assert.equal(groups[0].request, 'Think of names.');
  read = await readClaudeSubagents({ id: 's1', projectPath: '/fixture' }, transcript, cache);
  assert.equal(read.changed, false, 'Unchanged: not read again');
  appendFileSync(join(directory, 'agent-x.jsonl'), rec('assistant', [{ type: 'text', text: 'railbird' }]));
  read = await readClaudeSubagents({ id: 's1', projectPath: '/fixture' }, transcript, cache);
  assert.equal(read.changed, true);
  // A session with no subagents directory has none.
  assert.equal((await readClaudeSubagents({ id: 'other', projectPath: '/fixture' }, transcript)).byCall.size, 0);
});

test('a lead every Agent description shares is said once; anything less is left as written', () => {
  assert.deepEqual(agentGroup(['Name brainstorm: companion metaphors', 'Name brainstorm: reading and recording']), { lead: 'Name brainstorm', names: ['companion metaphors', 'reading and recording'] });
  assert.deepEqual(agentGroup(['审查：解析器', '审查：渲染']), { lead: '审查', names: ['解析器', '渲染'] });
  assert.deepEqual(agentGroup(['Review - parser', 'Review - render']), { lead: 'Review', names: ['parser', 'render'] });
  // One alone, leads that differ, a lead with nothing after it, no separator: as written.
  assert.deepEqual(agentGroup(['Name brainstorm: x']), { names: ['Name brainstorm: x'] });
  assert.deepEqual(agentGroup(['Fix: parser', 'Test: parser']), { names: ['Fix: parser', 'Test: parser'] });
  assert.deepEqual(agentGroup(['Name: ', 'Name: b']), { names: ['Name: ', 'Name: b'] });
  assert.deepEqual(agentGroup(['Explore the parser', 'Explore the render']), { names: ['Explore the parser', 'Explore the render'] });
});
