import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseClaude } from '../packages/core/src/claude';
import { visibleTurnGroups } from '../packages/core/src/outline';
import { turnView } from '../packages/core/src/turn-view';
import { fileChanges, fileRead, findRow, rowChanges, turnRows } from '../packages/core/src/call-target';
import { renderDetail } from '../packages/vscode/src/render';

const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 1, 0, second)).toISOString();
let uuid = 0;
const rec = (type: string, content: unknown, second: number, extra = {}) => ({ type, uuid: `u${++uuid}`, timestamp: at(second), sessionId: 'cl', cwd: '/fixture', message: { role: type, content }, ...extra });
const call = (id: string, name: string, input: unknown, second: number) => rec('assistant', [{ type: 'tool_use', id, name, input }], second);
const parse = (records: unknown[]) => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });

// One turn: a read of two lines of a file, then an edit of one of them, as Claude Code records them.
const session = () => parse([
  rec('user', '把 a 改成 2', 0),
  call('r1', 'Read', { file_path: '/fixture/src/a.ts', offset: 10, limit: 2 }, 1),
  rec('user', [{ type: 'tool_result', tool_use_id: 'r1', content: '    10\tconst a = 1;\n    11\tconst b = 2;' }], 2,
    { toolUseResult: { type: 'text', file: { filePath: '/fixture/src/a.ts', content: 'const a = 1;\nconst b = 2;', numLines: 2, startLine: 10, totalLines: 40 } } }),
  call('e1', 'Edit', { file_path: '/fixture/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, 3),
  rec('user', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }], 4,
    { toolUseResult: { type: 'update', filePath: '/fixture/src/a.ts', structuredPatch: [{ oldStart: 9, oldLines: 3, newStart: 9, newLines: 3, lines: [' // a', '-const a = 1;', '+const a = 2;', ' const b = 2;'] }], originalFile: 'x' } }),
]);
const rows = (data: ReturnType<typeof session>) => turnView(visibleTurnGroups(data)[0], false, 'claude').rows;

test('a read opens as the file itself, at the lines it read', () => {
  const data = session();
  const read = rows(data).find(row => row.tool === 'Read')!;
  assert.deepEqual(fileRead(data, read), { path: '/fixture/src/a.ts', start: 10, count: 2 });
  assert.deepEqual(rowChanges(data, read), [], 'A read changes nothing');
});

test('an edit opens as its change, with the line numbers the harness recorded and the changed word marked', () => {
  const data = session();
  const edit = rows(data).find(row => row.tool === 'Edit' || row.tool === 'Write')!;
  assert.equal(fileRead(data, edit), undefined);
  const files = rowChanges(data, edit);
  assert.equal(files.length, 1);
  // The file in the turn's Changes carries the id of the row that wrote it, and finds that row.
  const changed = turnView(visibleTurnGroups(data)[0], false, 'claude').turn.files[0];
  assert.equal(findRow(data, changed.id)?.row.id, edit.id);
  const found = findRow(data, edit.id)!;
  const evidence = { item: found.row.items[0] };
  const document = new JSDOM(renderDetail({ ...evidence, provider: 'claude', kept: false, nonce: 'n', change: { files, paths: ['src/a.ts'], title: 'a.ts' } })).window.document;
  assert.equal(document.querySelector('h1')!.textContent, 'a.ts');
  const lines = [...document.querySelectorAll('.dl')].map(line => [line.className.replace('dl', '').trim(), line.querySelector('.dn')!.textContent, line.querySelector('.dt')!.textContent]);
  assert.deepEqual(lines, [['', '9', '// a'], ['ddel', '10', 'const a = 1;'], ['dadd', '10', 'const a = 2;'], ['', '11', 'const b = 2;']]);
  assert.deepEqual([...document.querySelectorAll('.dl mark')].map(mark => mark.textContent), ['1', '2'], 'Only the word that changed');
});

test('a file changed twice in a turn steps from one change to the other, as < > in the terminal', () => {
  const data = parse([
    rec('user', '改两次', 0),
    call('e1', 'Edit', { file_path: '/fixture/src/a.ts', old_string: 'a = 1', new_string: 'a = 2' }, 1),
    rec('user', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }], 2,
      { toolUseResult: { type: 'update', filePath: '/fixture/src/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a = 1', '+a = 2'] }], originalFile: 'a = 1' } }),
    call('e2', 'Edit', { file_path: '/fixture/src/a.ts', old_string: 'a = 2', new_string: 'a = 3' }, 3),
    rec('user', [{ type: 'tool_result', tool_use_id: 'e2', content: 'ok' }], 4,
      { toolUseResult: { type: 'update', filePath: '/fixture/src/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a = 2', '+a = 3'] }], originalFile: 'a = 2' } }),
  ]);
  const group = visibleTurnGroups(data)[0];
  const steps = fileChanges(data, turnRows(group), '/fixture/src/a.ts');
  assert.deepEqual(steps.map(step => step.file.lines.at(-1)), ['+a = 2', '+a = 3']);
  // The turn's Changes line for the file opens its latest change.
  const changed = turnView(group, false, 'claude').turn.files[0];
  assert.equal(steps.findIndex(step => step.row.id === changed.id), 1);
  const html = renderDetail({ item: steps[1].row.items[0], provider: 'claude', kept: false, nonce: 'n',
    change: { files: [steps[1].file], paths: ['src/a.ts'], title: 'a.ts', edit: { index: 1, total: 2 } } });
  const document = new JSDOM(html).window.document;
  assert.match(document.querySelector('.edit-steps')!.textContent!, /第 2 次 \/ 共 2 次/);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-action="olderEdit"]')!.disabled, false);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-action="newerEdit"]')!.disabled, true, 'The latest change has none after it');
});
