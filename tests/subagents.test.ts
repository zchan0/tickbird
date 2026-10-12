import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeSubagents, type SubagentCache } from '../packages/core/src/subagents';
import { visibleTurnGroups } from '../packages/core/src/outline';
import { tempDir } from './temp';

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
