import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';
import { workflowMeta } from '../packages/core/src/agent-line';
import { renderSidecar, renderSubagentTurn } from '../packages/vscode/src/render';
import { setLanguage } from '../packages/core/src/i18n';

// Written for the Chinese pages: their words are checked as they read in Chinese.
setLanguage('zh');

const at = (second: number) => new Date(Date.UTC(2026, 9, 6, 1, 0, second)).toISOString();
let uuid = 0;
const rec = (type: string, content: unknown, second: number, extra = {}) => ({ type, uuid: `u${++uuid}`, timestamp: at(second), sessionId: 'cl', cwd: '/fixture', message: { role: type, content }, ...extra });
const call = (id: string, name: string, input: unknown, second: number) => rec('assistant', [{ type: 'tool_use', id, name, input }], second);
const result = (id: string, second: number, content = 'ok', toolUseResult?: unknown) => ({ ...rec('user', [{ type: 'tool_result', tool_use_id: id, is_error: false, content }], second), ...(toolUseResult ? { toolUseResult } : {}) });
const said = (text: string, second: number, end = false) => ({ ...rec('assistant', [{ type: 'text', text }], second), ...(end ? { message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } } : {}) });
const parse = (records: unknown[]) => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });

test('a workflow is read by its script\'s meta, or by the saved workflow it names', () => {
  const script = "export const meta = {\n  name: 'review-changes',\n  description: \"Review files, verify each finding\",\n  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'a {brace} inside' }],\n}\nconst x = { name: 'not-meta' }";
  assert.deepEqual(workflowMeta({ script }), { name: 'review-changes', description: 'Review files, verify each finding', phases: ['Review', 'Verify'] });
  assert.deepEqual(workflowMeta({ name: 'nightly-review' }), { name: 'nightly-review', description: '', phases: [] });
});

test('in the side bar a message, a skill and a workflow are set as Agent calls are, and their words can be selected', () => {
  const script = "export const meta = { name: 'review-changes', description: 'Review changed files', phases: [{ title: 'Review' }, { title: 'Verify' }] }";
  const session = parse([
    rec('user', '整理经验文档', 0),
    call('a1', 'Agent', { description: 'Compile lessons doc', prompt: 'p', run_in_background: true }, 1),
    result('a1', 1, 'launched', { isAsync: true, status: 'async_launched', agentId: 'a8a1', description: 'Compile lessons doc', prompt: 'p', outputFile: '/tmp/o' }),
    said('让它接着做。', 2),
    call('m1', 'SendMessage', { to: 'a8a1', summary: 'Resume lessons doc', message: 'Resume.' }, 3), result('m1', 3, 'Resuming', { success: true, message: 'Resuming', resumedAgentId: 'a8a1' }),
    said('用 schedule 技能。', 4),
    call('k1', 'Skill', { skill: 'schedule', args: '设置提醒' }, 5), result('k1', 5),
    said('用 workflow。', 6),
    call('w1', 'Workflow', { script }, 7), result('w1', 7, 'Workflow started'),
    said('都安排好了。', 8, true),
  ]);
  const html = renderSidecar({ projectName: 'p', session, nonce: 'n' });
  assert.match(html, /<div class="ctool">SendMessage<\/div><ol class="cagent-list"><li[^>]*><div class="crow cagent node-button" role="button" tabindex="0"[^>]*data-tool="SendMessage"[^>]*><span class="csym" aria-hidden="true">→<\/span><span class="clabel">Compile lessons doc<\/span><span class="cfacts">Resume lessons doc<\/span>/);
  assert.match(html, /<span class="csym" aria-hidden="true">◆<\/span><span class="clabel">schedule<\/span><span class="cfacts">设置提醒<\/span>/);
  assert.match(html, /<div class="ctool">Workflow<span class="clead"> · review-changes<\/span><\/div>/);
  assert.match(html, /data-tool="Workflow" data-state="running"[^>]*><span class="cdot" aria-hidden="true"><\/span><span class="clabel">Review changed files<\/span><ol class="cphases"><li>Review<\/li><li>Verify<\/li><\/ol><span class="cfacts">后台 · /);
  // Rows open their detail, as buttons did, and their words can be selected.
  assert.ok(!/<button[^>]*class="crow/.test(html));
  assert.match(html, /\[role="button"\]\[data-item-id\] \{ cursor: pointer; user-select: text; \}/);
});

test('a subagent\'s page says what it was given as its Task, what it gave back as its Result', () => {
  const subagent = parse([rec('user', 'Name the tool.', 0), said('railbird.', 1, true)]);
  const html = renderSubagentTurn(subagent, false);
  assert.match(html, /<div class="tlabel">Task<\/div>/);
  assert.match(html, /<div class="tlabel">Result<\/div>/);
  assert.ok(!html.includes('>Prompt<') && !html.includes('>Final Answer<'));
});
