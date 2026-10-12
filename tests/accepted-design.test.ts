import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseCodex } from '../packages/core/src/codex';
import { summarizeShell } from '../packages/core/src/actions';
import { shortFileLabels } from '../packages/core/src/presentation';
import { resolveOutlineEvidence } from '../packages/core/src/outline';
import { renderSidecar, renderInlineEvidence, renderDetail } from '../packages/vscode/src/render';
const r = (payload: unknown) => ({ type: 'response_item', payload });
const e = (payload: unknown) => ({ type: 'event_msg', payload });
const parse = (...records: unknown[]) => parseCodex({ file: '/fixture/session.jsonl', projectPath: '/fixture', text: [{ type: 'session_meta', payload: { id: 's', cwd: '/fixture' } }, e({ type: 'task_started', turn_id: 't' }), ...records].map(record => JSON.stringify(record)).join('\n') });
const documentFor = (data: ReturnType<typeof parse>) => new JSDOM(renderSidecar({ projectName: 'fixture', session: data, nonce: 'test' })).window.document;
const patch = '*** Begin Patch\n*** Update File: /fixture/a.ts\n@@\n-old\n+new\n*** End Patch';
const nativePatch = (text = '-old\n+new') => e({ type: 'item_completed', item: { type: 'FileChange', id: 'native-file', status: 'completed', changes: { '/fixture/a.ts': { type: 'update', unified_diff: text } } } });

test('compound shell summary captures the requested four purposes and does not interpret quoted or dynamic scripts', () => {
  const command = "git status --short\nrg --files --hidden -g '!node_modules/**' -g '!dist/**' -g 'AGENTS.md'\ncat package.json\nsed -n '1,120p' README.md\nrg -n 'tickbird|实时|Bash' /Users/example/.codex/memories/MEMORY.md";
  assert.equal(summarizeShell(command), '检查 Git 状态；查找项目规范；读取 package.json / README.md；检索项目记忆');
  assert.equal(summarizeShell("echo 'git status; cat secrets'"), "输出文本 · git status; cat secrets");
  assert.match(summarizeShell('cat "$(resolve)"'), /动态参数/);
  assert.equal(summarizeShell("python3 - <<'PY'\nprint('test')\nPY"), '运行 python3 脚本');
});

test('native MCP pairs with regular input/output in either order, while hidden blocks and metadata stay excluded', () => {
  const output = { content: [{ type: 'text', text: 'PUBLIC_MCP_RESULT' }, { type: 'thinking', text: 'PRIVATE_THINKING' }], _meta: { private: 'PRIVATE_META' }, isError: true };
  const input = r({ type: 'function_call', namespace: 'mcp__example', name: 'lookup', call_id: 'c', arguments: '{"query":"fixture"}' });
  const native = e({ type: 'item_completed', item: { type: 'McpToolCall', id: 'c', server: 'example', tool: 'lookup', arguments: { query: 'fixture' }, status: 'completed', result: output } });
  for (const records of [[input, native], [native, input]]) {
    const data = parse(...records, r({ type: 'function_call_output', call_id: 'c', output }));
    const tools = data.items.filter(item => item.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'failed');
    assert.equal(tools[0].detail!.blocks.filter(block => block.text === 'PUBLIC_MCP_RESULT').length, 1);
    assert.ok(!JSON.stringify(data.items).includes('PRIVATE_'));
    assert.ok(!data.coverage.some(entry => entry.kind === 'item:McpToolCall' && entry.disposition === 'unsupported'));
    assert.equal(documentFor(data).querySelectorAll('.crow-item').length, 1, 'One call, one row');
  }
});

/** A row that changed a file: Write, or Edit when it patched one, as in the terminal. */
const CHANGE = '.crow:is([data-tool="Write"], [data-tool="Edit"])';

test('a native patch mirror joins exactly one pending input; unrelated and ambiguous changes stay separate', () => {
  const input = (id: string) => r({ type: 'custom_tool_call', name: 'apply_patch', call_id: id, input: patch });
  const merged = parse(input('patch'), nativePatch());
  const writes = (data: ReturnType<typeof parse>) => documentFor(data).querySelectorAll(CHANGE).length;
  assert.equal(writes(merged), 1);
  assert.equal(merged.items.find(item => item.kind === 'file-change')!.sources.length, 2);
  assert.equal(writes(parse(input('patch'), nativePatch('-different\n+new'))), 2);
  assert.equal(writes(parse(input('first'), input('second'), nativePatch())), 3);
});

test('a mixed wrapper attaches the native patch to Write without assigning shared results to sibling inputs', () => {
  const source = `await tools.apply_patch(${JSON.stringify(patch)}); await tools.exec_command({cmd:"npm test"});`;
  const data = parse(r({ type: 'custom_tool_call', name: 'exec', call_id: 'wrapper', input: source }), nativePatch(), r({ type: 'custom_tool_call_output', call_id: 'wrapper', output: 'SHARED_RESULT' }));
  const document = documentFor(data);
  assert.equal(document.querySelectorAll(CHANGE).length, 1);
  assert.equal(document.querySelectorAll('.crow').length, 2, 'The shared result is a record of the calls, with no row of its own');
  const host = document.querySelector<HTMLElement>('.crow[data-tool="Bash"]')!;
  const evidence = resolveOutlineEvidence(data, host.dataset.itemId!)!;
  const inline = renderInlineEvidence(evidence);
  assert.ok(inline.includes('npm test'));
  assert.ok(!inline.includes('SHARED_RESULT'));
  assert.ok(!inline.includes('data-io="output"'));
  const button = document.querySelector<HTMLElement>(CHANGE)!;
  const file = resolveOutlineEvidence(data, button.dataset.itemId!)!;
  assert.equal(file.item.sources.length, 3);
  assert.equal(file.item.detail!.blocks[0].text, '@@\n-old\n+new');
  const detail = new JSDOM(renderDetail({ ...file, provider: 'codex', kept: false, nonce: 'test' })).window.document;
  assert.equal(detail.querySelector('[data-io="output"]'), null);
  assert.ok(detail.querySelector('.sources')!.textContent!.includes('SHARED_RESULT'));
  assert.equal(detail.querySelector<HTMLDetailsElement>('.sources')!.open, false);
  assert.ok(detail.querySelector('.patch')!.textContent!.includes('+new'));
});

test('file details isolate the selected historical file and disambiguate identical basenames', () => {
  const input = '*** Begin Patch\n*** Update File: /repo/one/src/a.ts\n@@\n-old_one\n+new_one\n*** Update File: /repo/two/src/a.ts\n@@\n-old_two\n+new_two\n*** End Patch';
  const data = parse(r({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'files', input }));
  assert.deepEqual(shortFileLabels(['/repo/one/src/a.ts', '/repo/two/src/a.ts']), ['one/src/a.ts', 'two/src/a.ts']);
  const document = documentFor(data), buttons = [...document.querySelectorAll<HTMLElement>(CHANGE)];
  assert.equal(buttons.length, 2, 'One row per file');
  assert.deepEqual(buttons.map(button => button.querySelector('.clabel')!.textContent), ['one/src/a.ts', 'two/src/a.ts']);
  // The Changes list opens the same per-file records; nothing else is clickable.
  const ids = new Set(buttons.map(button => button.dataset.itemId));
  assert.ok([...document.querySelectorAll<HTMLElement>('button[data-item-id]')].every(button => ids.has(button.dataset.itemId)));
  const first = resolveOutlineEvidence(data, buttons[0].dataset.itemId!)!;
  assert.match(first.item.detail!.blocks[0].text!, /new_one/);
  assert.ok(!JSON.stringify(first).includes('new_two'));
  assert.equal(resolveOutlineEvidence(parse(), buttons[0].dataset.itemId!), undefined);
});

test('agent prose is shown whole with its attachments; Read has no separate output badge', () => {
  const data = parse(r({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'A long paragraph. '.repeat(40) }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RZ0AAAAASUVORK5CYII=' }] }), r({ type: 'function_call', name: 'Read', call_id: 'read', arguments: '{"file_path":"/fixture/a.ts"}' }), r({ type: 'function_call_output', call_id: 'read', output: 'FILE_CONTENT' }));
  const document = documentFor(data);
  // The agent's own words are shown whole: no clamp, no "expand" control.
  assert.ok(document.querySelector('.csay')!.textContent!.length > 500);
  assert.equal(document.querySelector('.csay [data-toggle-text]'), null);
  assert.ok(document.querySelector('.csay .narrative-attachments'));
  assert.equal(document.querySelector('.crow .output-indicator'), null);
});
