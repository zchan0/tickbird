import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { toolView } from '../packages/core/src/tool-view';
import { describeDisplayAction, presentEvidence } from '../packages/core/src/presentation';
import { parseCodex } from '../packages/core/src/codex';
import { renderSidecar, renderDetail } from '../packages/vscode/src/render';
import { presentationCases } from './fixtures/presentation-cases';
import { setLanguage } from '../packages/core/src/i18n';

// Written for the Chinese pages: their words are checked as they read in Chinese.
setLanguage('zh');
const sample = () => structuredClone(presentationCases.find(value => value.id === 'semantic-tools')!.session);
const detail = (id: string) => new JSDOM(renderDetail({ item: sample().items.find(item => item.id === id)!, provider: 'codex', kept: false, nonce: 'test' })).window.document;

test('proven reads use semantic labels with full command retained in the source metadata', () => {
  const data = sample(), before = JSON.stringify(data);
  const entries = data.items.slice(1).map(item => describeDisplayAction(item).entries[0]);
  assert.deepEqual(entries.map(entry => entry.toolName), ['Skill', 'Memory', 'Instructions', 'WebSearch', 'WebFetch', 'Goal', 'Computer', 'Example']);
  assert.equal(entries[0].label, 'openai-docs · 读取定义');
  assert.equal(entries[5].label, '查看目标');
  assert.equal(entries[6].label, '检查窄栏样例');
  // A single-file read opens as the file; its command stays in the folded sources.
  assert.ok(detail('tool').querySelector('.file-reading'));
  assert.ok(detail('tool').querySelector('[data-evidence-source]')!.textContent!.includes('cat /fixture/.codex/skills/.system/openai-docs/SKILL.md'));
  assert.ok(detail('tool').querySelector('.source-metadata')!.textContent!.includes('exec_command'));
  assert.equal(JSON.stringify(data), before);
});

test('quoted text, dynamic shell, unknown options and compound writes never become skill reads', () => {
  const path = '/fixture/.codex/skills/.system/openai-docs/SKILL.md';
  for (const command of [`echo 'cat ${path}'`, `cat ${path} > out`, `cat ${path} && npm test`, `cat "$(resolve)"`, `sh -c 'cat ${path}'`, `cat /skills/*/SKILL.md`, `sed -i '1p' ${path}`, `sed 'e pwd' ${path}`, `cat --unknown ${path}`]) {
    assert.equal(toolView('exec_command', { cmd: command }).name, 'Bash', command);
  }
  for (const command of [`cat '${path}'`, `head -n 20 ${path}`, `sed -n '1,20p' ${path}`]) assert.equal(toolView('Bash', { command }).name, 'Skill');
  assert.equal(toolView('Read', { file_path: path }).label, 'openai-docs · 读取定义');
  assert.equal(toolView('Skill', { skill: 'openai-docs' }).label, 'openai-docs');
});

test('namespaced CUA input follows the real Codex adapter, keeps JavaScript highlighting and does not duplicate protocol names', () => {
  const data = parseCodex({ file: '/synthetic/cua.jsonl', projectPath: '/synthetic', text: JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__cua_repl', name: 'js', call_id: 'cua', arguments: JSON.stringify({ title: '检查浏览器', code: 'await tab.getState();' }) } }) });
  const html = new JSDOM(renderSidecar({ projectName: 'test', session: data, nonce: 'test' })).window.document;
  assert.equal(html.querySelector('.crun .ctool')!.textContent, 'Computer');
  assert.equal(html.querySelector('.crow .clabel')!.textContent, '检查浏览器');
  const evidence = new JSDOM(renderDetail({ item: data.items.find(item => item.kind === 'tool')!, provider: 'codex', kept: false, nonce: 'test' })).window.document;
  assert.equal(evidence.querySelector('[data-io="input"] code')!.textContent, 'await tab.getState();');
  assert.ok(evidence.querySelector('.hljs-keyword'));
});

test('web operations and MCP arguments get structured fields, with unknown fields preserved and escaped', () => {
  const web = detail('web-search');
  assert.equal(web.querySelector('.tool-fields dt')!.textContent, '搜索');
  assert.equal(web.querySelector('.tool-fields dd')!.textContent, 'VS Code webview');
  assert.ok(web.querySelector('[data-io="input"] details')!.textContent!.includes('search_query'));
  const mcp = detail('mcp');
  assert.equal(mcp.querySelector('.tool-fields dd')!.textContent, 'Workspace guide');
  assert.ok(mcp.querySelector('.tool-fields')!.textContent!.includes('3'));
  assert.equal(toolView('mcp__cua_repl__js', { code: 'malicious()', title: '<script>source</script>' }).label, '<script>source</script>');
  assert.equal(toolView('mcp__cua_repl__js', { code: 'arbitrary()' }).label, '执行 JavaScript');
});

test('Goal has no empty Input, output fields preserve real status without inferring completion', () => {
  const goal = detail('goal');
  assert.equal(goal.querySelector('[data-io="input"]'), null);
  assert.equal(goal.querySelector('[data-io="output"] dt')!.textContent, '目标');
  assert.ok(goal.querySelector('[data-io="output"]')!.textContent!.includes('active'));
});

test('unknown tools have one formatted identity with input hints, not name repeated as purpose', () => {
  assert.deepEqual(toolView('mcp__example__unseen_operation', {}), { name: 'Example', label: 'unseen operation', type: 'TOOL', operation: 'unseen_operation' });
  // A long server identifier becomes a short app name; what it did moves into the label.
  assert.deepEqual(['mcp__claude-in-chrome__computer', 'mcp__Claude_Browser__navigate', 'mcp__claude_ai_Notion__notion-create-pages', 'mcp__computer-use__screenshot']
    .map(name => [toolView(name, { action: 'screenshot' }).name, toolView(name, {}).label]),
    [['Chrome', 'computer'], ['Browser', 'navigate'], ['Notion', 'create pages'], ['Computer', 'screenshot']]);
  // Never the input's keys alone: what it was asked to do, what it worked on, else a value with its key.
  assert.equal(toolView('Artifact', { action: 'quickstart', intent: 'other', design_systems: false }).label, 'quickstart · other');
  assert.equal(toolView('Artifact', { file_path: '/tmp/x/design/v4.html', description: 'A long sentence' }).label, 'v4.html · A long sentence');
  assert.equal(toolView('web.run', { open: [{ ref_id: 'https://a.com/x' }], find: [{ ref_id: 'https://a.com/x', pattern: 'effort' }] }).label, 'Open a.com/x；Find effort');
  assert.equal(toolView('new_tool', { count: 2 }).label, 'count 2');
  assert.equal(toolView('new_tool', {}).label, '');
  assert.equal(toolView('ToolSearch', { query: 'select:WebSearch,WebFetch' }).label, 'WebSearch, WebFetch');
  assert.equal(toolView('WebFetch', { url: 'https://www.example.com/docs/' }).label, 'example.com/docs');
  assert.equal(toolView('write_stdin', { chars: '\u0003' }).label, '输入 · Ctrl-C');
  assert.equal(toolView('SendMessage', { to: 'reviewer', message: 'Check the diff' }).label, 'reviewer · Check the diff');
  // Codex reaches its connected apps through one server: the app goes by its own name.
  assert.deepEqual([toolView('mcp__codex_apps__notion.fetch', { id: 'p1' }).name, toolView('mcp__codex_apps__notion.notion-get-tool-access', {}).label], ['Notion', 'get tool access']);
  // A read with its lines, where the call says.
  assert.equal(toolView('Bash', { command: 'sed -n 85,135p packages/core/src/outline.ts' }).label, 'outline.ts:85-135');
  assert.equal(toolView('Read', { file_path: '/p/a.ts', offset: 10, limit: 20 }).label, 'a.ts:10-29');
  assert.equal(toolView('Read', { file_path: '/p/a.ts' }).label, 'a.ts');
});

test('mixed wrapper input semantics never allocate its shared result to individual operations', () => {
  const item = sample().items[1];
  item.title = 'exec';
  item.detail!.blocks[0].text = 'text(await tools.exec_command({cmd:"cat /fixture/AGENTS.md"})); text(await tools.get_goal({})); text(await tools.mcp__cua_repl__js({title:"检查界面",code:"await tab.getState()"}));';
  assert.deepEqual(describeDisplayAction(item).entries.map(entry => entry.toolName), ['Instructions', 'Goal', 'Computer']);
  assert.equal(presentEvidence(item).outputs.length, 1);
  const data = sample(); data.items = [data.items[0], item];
  const document = new JSDOM(renderSidecar({ projectName: 'test', session: data, nonce: 'test' })).window.document;
  // As in the terminal, a shared output is a record of the calls, not a step: it opens from them and takes no row.
  assert.deepEqual([...document.querySelectorAll('.crow')].map(node => node.getAttribute('data-tool')), ['Instructions', 'Goal', 'Computer']);
});

test('lens body comes from the full request rather than a truncated summary', () => {
  const data = structuredClone(presentationCases.find(value => value.id === 'turn-preview')!.session);
  const doc = new JSDOM(renderSidecar({ projectName: 'test', session: data, nonce: 'test' })).window.document;
  const preview = doc.querySelector('[data-lens-turn-id="turn:turn-2"]')!;
  assert.equal(preview.querySelector('.turn-lens-title'), null);
  assert.ok(preview.querySelector('.turn-lens-request')!.textContent!.startsWith('优化工具展示。'));
  assert.ok(preview.querySelector('.turn-lens-request')!.textContent!.includes('超过三行的部分'));
  assert.ok(!doc.querySelector('.toc')!.getAttribute('aria-label')!.includes('附近'));
});
