import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { recordedToolInputs } from '../packages/core/src/actions';
import { describeDisplayAction, presentEvidence, parsePatch } from '../packages/core/src/presentation';
import { parseCodex } from '../packages/core/src/codex';
import { renderDetail, renderSidecar } from '../packages/vscode/src/render';
import { actionRowSections, outlineTurn } from '../packages/core/src/outline';
import { groupSessionTurns } from '../packages/core/src/timeline';
import type { TimelineItem } from '../packages/core/src/model';
const call = (name: string, input: unknown, outputs: string[] = []): TimelineItem => ({
  id: 'call', sessionId: 'fixture', turnId: 'turn', kind: 'tool', title: name, summary: '', status: 'completed', result: outputs.length ? 'readable' : 'not-observed', availability: 'available', sources: [{ file: '/synthetic/session.jsonl', line: 1 }],
  detail: { title: name, blocks: [{ kind: 'code', label: '记录中的调用参数', text: typeof input === 'string' ? input : JSON.stringify(input) }, ...outputs.map(text => ({ kind: 'text' as const, label: '当时返回的内容', text }))] },
});
const dom = (item: TimelineItem) => new JSDOM(renderDetail({ item, provider: 'codex', kept: false, nonce: 'fixture-nonce' })).window.document;
const envelope = (output: string) => JSON.stringify({ chunk_id: 'one', wall_time_seconds: 0.1, exit_code: 0, output });

test('display names preserve concrete operations and promote proven reads without relabeling other shell commands', () => {
  assert.equal(describeDisplayAction(call('exec_command', { cmd: 'cat src/a.ts' })).entries[0].toolName, 'Read');
  // A command that only searches or lists goes by that tool's name, as Codex names it.
  assert.equal(describeDisplayAction(call('exec_command', { cmd: 'rg -n output src' })).entries[0].toolName, 'Search');
  assert.equal(describeDisplayAction(call('exec_command', { cmd: 'rg --files -g AGENTS.md src' })).entries[0].toolName, 'List');
  for (const cmd of ['npm test', 'git diff --stat', 'printf "hello" | sed -n 1p', 'rg -n output src | wc -l', 'cat a.ts && npm test']) {
    const entry = describeDisplayAction(call('exec_command', { cmd })).entries[0];
    assert.equal(entry.toolName, 'Bash'); assert.ok(entry.label.length > 0);
    assert.equal(recordedToolInputs(call('exec_command', { cmd }))[0].input && (recordedToolInputs(call('exec_command', { cmd }))[0].input as { cmd: string }).cmd, cmd);
  }
  assert.equal(describeDisplayAction(call('apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch')).entries[0].toolName, 'Write');
  assert.equal(describeDisplayAction(call('Read', { file_path: '/fixture/a.ts' })).entries[0].toolName, 'Read');
});
test('static nested inputs retain full commands and never execute or expand dynamic branches', () => {
  const item = call('exec', 'text(await tools.exec_command({cmd:"cat a.ts && cat b.ts"})); text(await tools.apply_patch("*** Begin Patch\\n*** Delete File: old.ts\\n*** End Patch"));');
  assert.deepEqual(recordedToolInputs(item).map(call => call.name), ['exec_command', 'apply_patch']);
  assert.equal(describeDisplayAction(item).entries.length, 2, 'A compound shell is one actual invocation');
  for (const source of ['if (ok) await tools.exec_command({cmd:"maybe"});', 'const tools = fake; await tools.exec_command({cmd:"maybe"});', 'await tools.exec_command({cmd:"pwd",workdir:path});']) {
    assert.deepEqual(recordedToolInputs(call('exec', source)), [{ name: 'exec', input: source }]);
  }
});
test('known shell wrapper envelopes display one Output region without transport headers or escaped JSON copies', () => {
  const item = call('exec', 'text(await tools.exec_command({cmd:"npm test"}));', ['Script completed\nWall time 0.1 seconds\nOutput:\n', envelope('PASS\n  2 tests\n')]);
  const before = JSON.stringify(item), document = dom(item);
  assert.equal(document.querySelectorAll('[data-io="output"]').length, 1);
  assert.equal(document.querySelector('[data-io="output"] code')!.textContent, 'PASS\n  2 tests\n');
  assert.equal(document.querySelector('[data-io="input"] code')!.textContent, 'npm test');
  assert.ok(!document.querySelector('.detail-content')!.textContent!.includes('wall_time_seconds'));
  assert.equal(JSON.stringify(item), before);
  assert.equal(presentEvidence(call('apply_patch', '*** Begin Patch\n*** Delete File: old.ts\n*** End Patch', ['{}'])).outputs.length, 0);
  assert.equal(presentEvidence(call('Bash', { command: 'printf "{}"' }, ['{}'])).outputs[0].text, '{}');
});
test('multiple envelopes unwrap without positional attribution; quoted metadata and unknown payloads remain literal', () => {
  const input = 'text(await tools.exec_command({cmd:"a"})); text(await tools.exec_command({cmd:"b"}));';
  const parsed = presentEvidence(call('exec', input, [envelope('first') + envelope('second')]));
  assert.deepEqual(parsed.outputs.map(block => block.text), ['first', 'second']);
  assert.equal(parsed.calls.length, 2);
  const unknown = JSON.stringify({ chunk_id: 'one', wall_time_seconds: 0.1, output: 'x', extraPayload: 'KEEP' });
  assert.equal(presentEvidence(call('exec', input, [unknown])).outputs[0].text, unknown);
  assert.equal(presentEvidence(call('Read', { file_path: 'source.json' }, [envelope('literal file')])).outputs[0].text, envelope('literal file'));
  assert.equal(presentEvidence(call('exec_command', { cmd: 'echo' }, ['actual stdout\nScript completed\nOutput:\nkeep'])).outputs[0].text, 'actual stdout\nScript completed\nOutput:\nkeep');
});
test('patch reader lists full paths, move target and additions/removals without invented positions', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/new/a.ts\n@@\n-old\n+new\n*** Add File: test/a.ts\n+new file\n*** Delete File: old.ts\n*** End Patch';
  const files = parsePatch(patch)!;
  assert.equal(files.length, 3); assert.equal(files[0].moveTo, 'src/new/a.ts');
  const document = dom(call('apply_patch', patch));
  assert.equal(document.querySelectorAll('.patch-file').length, 3);
  assert.equal(document.querySelector('.patch-removed')!.textContent, '-old');
  assert.ok(document.querySelector('.patch-file h3')!.textContent!.includes('src/new/a.ts'));
  assert.equal(parsePatch('*** Begin Patch\n*** Update File: broken'), undefined);
});
test('Edit diff keeps replace_all parameter and code readers preserve whitespace with safe highlighting', () => {
  const document = dom(call('Edit', { file_path: 'src/a.ts', old_string: 'old', new_string: '<script>new</script>', replace_all: true }));
  assert.equal(document.querySelector('.patch-added')!.textContent, '+<script>new</script>');
  assert.ok(document.querySelector('details code')!.textContent!.includes('replace_all'));
  assert.equal(document.querySelectorAll('script').length, 1, 'Only the nonce-protected application script');
  const command = dom(call('Bash', { command: 'printf "%s" "<script>bad</script>"\n', cwd: '/fixture' }));
  assert.equal(command.querySelector('code')!.textContent, 'printf "%s" "<script>bad</script>"\n');
  assert.ok(command.querySelector('.hljs-string'));
});
test('detail prose shares Markdown reader and has no injected scope, duplicate generic headings or warning wall', () => {
  const item: TimelineItem = { ...call('message', ''), kind: 'message', detail: { title: '过程说明', notice: '解释性文字', provenance: '按动作整理的来源记录', blocks: [{ kind: 'text', label: '用户请求或公开正文', text: '**重点**\n\n```ts\nconst a = 1;\n```' }] } };
  const document = dom(item);
  assert.equal(document.querySelector('strong')!.textContent, '重点');
  assert.ok(document.querySelector('.hljs-keyword'));
  assert.equal(document.querySelectorAll('.evidence-scope, .evidence-notices, .eyebrow').length, 0);
  assert.equal(document.querySelectorAll('.detail-content h3').length, 0);
});
test('Output has a separate closed disclosure, never an action, and partial wrapper inputs are not lost', () => {
  const input = 'text(await tools.exec_command({cmd:"cat a.ts"})); text(await tools.exec_command({cmd:"cat b.ts"}));';
  const data = parseCodex({ file: '/synthetic/session.jsonl', projectPath: '/synthetic', text: [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call', arguments: input } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'Script completed\nOutput:\n' + envelope('body') } },
  ].map(record => JSON.stringify(record)).join('\n') });
  const document = new JSDOM(renderSidecar({ projectName: 'fixture', session: data, nonce: 'fixture' })).window.document;
  // The shared output is one row of its own, not an action and not copied onto the reads.
  assert.equal(document.querySelectorAll('.crow[data-tool="OUT"]').length, 1);
  assert.deepEqual([...document.querySelectorAll('.crow')].map(node => node.getAttribute('data-tool')), ['Read', 'Read', 'OUT']);
  const tool = data.items.find(item => item.kind === 'tool')!; tool.status = 'running'; tool.result = 'partial'; tool.availability = 'partial';
  const group = outlineTurn(groupSessionTurns(data)[0]).nodes.find(node => node.kind === 'actions')!;
  assert.ok(group.kind === 'actions');
  assert.equal(actionRowSections(group).flatMap(section => section.rows).filter(row => row.role !== 'output').length, 2);
});
