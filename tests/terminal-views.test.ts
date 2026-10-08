import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';
import { visibleTurnGroups } from '../packages/core/src/outline';
import { turnView } from '../packages/core/src/turn-view';
import type { SessionData } from '../packages/core/src/model';
import type { LiveExtras } from '../packages/core/src/live-extras';
import { SYMBOLS } from '../packages/terminal/src/caps';
import { fitKeys, frame, initialState, key, openDetail, update, windowTitle, type AppState, type Model } from '../packages/terminal/src/app';
import { diffLines, fileLines } from '../packages/terminal/src/views/detail';
import type { InputEvent } from '../packages/terminal/src/input';
import { plainText, spans, type Line } from '../packages/terminal/src/screen';
import { contentsEntries, contentsLines } from '../packages/terminal/src/views/contents';
import { columnWidths, inlineSpans, prose, wrapSpans } from '../packages/terminal/src/views/prose';
import { headerLines, runningClock, sessionStatus, turnBody, type PageContext } from '../packages/terminal/src/views/turn-page';
import { textWidth } from '../packages/terminal/src/width';

const at = (second: number) => new Date(Date.UTC(2026, 9, 6, 1, 0, second)).toISOString();
let uuid = 0;
const rec = (type: string, content: unknown, second: number, extra = {}) => ({ type, uuid: `u${++uuid}`, timestamp: at(second), sessionId: 'cl', cwd: '/fixture', message: { role: type, content }, ...extra });
const call = (id: string, name: string, input: unknown, second: number) => rec('assistant', [{ type: 'tool_use', id, name, input }], second);
const result = (id: string, second: number, isError = false, content = 'ok') => rec('user', [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }], second);
const said = (text: string, second: number, end = false) => ({ ...rec('assistant', [{ type: 'text', text }], second), ...(end ? { message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } } : {}) });
const done = (second: number, ms: number) => ({ type: 'system', subtype: 'turn_duration', durationMs: ms, uuid: `d${++uuid}`, timestamp: at(second), sessionId: 'cl' });

const FIRST = [
  rec('user', '先看看测试为什么失败，再修好它', 0),
  said('先跑一遍测试，看失败在哪一步。', 1),
  call('t1', 'Bash', { command: 'npm test', description: 'Run the unit tests' }, 2), result('t1', 5, true, 'Exit code 1\nAssertionError'),
  call('t2', 'Bash', { command: 'npm test -- --grep width', description: 'Run only the width tests' }, 6), result('t2', 7),
  call('t3', 'Read', { file_path: '/fixture/src/width.ts' }, 8), result('t3', 9, false, '1\tconst a = 1;'),
  said('断言写反了：期望值和实际值调换了位置。改正后重跑：', 10),
  call('t4', 'Edit', { file_path: '/fixture/tests/width.test.ts', old_string: 'a', new_string: 'b' }, 11), result('t4', 12),
  said('修好了：`assert.equal` 的两个参数写反了。', 13, true),
  done(14, 14_000),
];
const SECOND = [
  rec('user', '再加一个回归测试，覆盖这个 bug 的场景，顺便检查一下有没有类似的断言也写反了', 20),
  said('先找出所有类似的断言。', 21),
  call('t5', 'Bash', { command: 'grep -rn "assert.equal(expected" tests', description: 'Search for reversed assertions' }, 22),
];

const parse = (records: unknown[]): SessionData => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
const ONE_CELL = { links: false, symbols: Object.fromEntries(Object.keys(SYMBOLS).map(ch => [ch, 1])) };

function modelOf(session: SessionData, options: { now?: number; extras?: LiveExtras; width?: number; height?: number; busy?: boolean } = {}): Model {
  const groups = visibleTurnGroups(session);
  const extras = options.extras ?? {};
  const now = options.now ?? Date.parse(at(30));
  const latest = groups.length ? turnView(groups[groups.length - 1], true, 'claude') : undefined;
  return { session, groups, extras, caps: ONE_CELL, now, width: options.width ?? 62, height: options.height ?? 30, status: sessionStatus(latest, extras, now, { busy: options.busy }) };
}
const ctxOf = (model: Model, index: number): PageContext => ({ ...model, index });
const text = (lines: Line[]) => lines.map(plainText);
const keyOf = (name: string): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false });

test('every line of the page, the header and 目录 fits the pane, from 30 to 120 columns', () => {
  const session = parse([...FIRST, ...SECOND]);
  for (const width of [30, 40, 62, 120]) {
    const model = modelOf(session, { width });
    for (const index of [0, 1]) {
      for (const line of [...headerLines(ctxOf(model, index)), ...turnBody(ctxOf(model, index))]) assert.ok(textWidth(plainText(line)) <= width, `${width}: ${plainText(line)}`);
    }
    const entries = contentsEntries(model.groups, 'claude', model.status, ONE_CELL, model.now);
    for (const line of contentsLines(entries, 1, width, ONE_CELL)) assert.ok(textWidth(plainText(line)) <= width, `${width}: ${plainText(line)}`);
    let state = update(initialState(), model);
    for (const mode of ['turn', 'contents', 'help'] as const) {
      state = { ...state, mode };
      const lines = frame(state, model);
      assert.equal(lines.length, model.height, mode);
      for (const line of lines) assert.ok(textWidth(plainText(line)) <= width, `${width} ${mode}: ${plainText(line)}`);
    }
  }
});

test('a finished turn: request, Changed, chapters with their calls, the agent’s done line; blocks one blank line apart', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  const lines = text(turnBody(ctxOf(model, 0)));
  assert.equal(lines[0], ' ┃ 先看看测试为什么失败，再修好它');
  assert.equal(lines[1], '');
  assert.match(lines[2], /^ {3}Changed {2}M width\.test\.ts$/);
  assert.equal(lines[3], '');
  assert.equal(lines[4], ' ● 先跑一遍测试，看失败在哪一步。');
  // Calls follow their chapter's words directly; the tool is written once per run.
  // The tool column is as wide as the longest tool name in the turn (Write).
  assert.match(lines[5], /^ {5}Bash {3}Run the unit tests +exit 1 → $/);
  // A call with a record to show ends in a dim arrow.
  assert.match(lines[6], /^ {12}Run only the width tests +→ $/);
  assert.match(lines[7], /^ {5}Read {3}width\.ts +→ $/);
  assert.equal(lines[8], '');
  assert.equal(lines[9], ' ● 断言写反了：期望值和实际值调换了位置。改正后重跑：');
  assert.match(lines[10], /^ {5}Write  width\.test\.ts +→ $/);
  assert.equal(lines[11], '');
  assert.equal(lines[12], '   修好了：assert.equal 的两个参数写反了。');
  assert.equal(lines[13], '');
  assert.match(lines[14], /^ ✻ \w+ for 14s · 4 calls$/);
  assert.equal(lines.length, 15);
  // Only a real failure is red.
  const failed = turnBody(ctxOf(model, 0))[5];
  assert.ok(spans(failed).some(span => span.text === 'exit 1' && span.style?.fg === 'red'));
});

test('the running turn ends with the agent’s word and a clock; a call still out is marked', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  assert.equal(model.status.kind, 'running');
  const lines = text(turnBody(ctxOf(model, 1)));
  assert.match(lines.at(-1)!, /^ ● \S+… 10s$/);
  assert.match(lines.at(-3)!, /Search for reversed assertions +… → $/);
  const header = text(headerLines(ctxOf(model, 1)));
  assert.match(header[0], /^ Claude Code .*● 运行中 10s $/);
  assert.match(header[1], /^ 第 2 轮 \/ 共 2 +\d\d:\d\d 开始 $/);
});

test('a quiet open turn is not called running', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { now: Date.parse(at(22)) + 11 * 60_000 });
  assert.equal(model.status.kind, 'quiet');
  assert.match(text(turnBody(ctxOf(model, 1))).at(-1)!, /^ 无新记录 · 最后一条 \d\d:\d\d$/);
  // The agent's own word wins over the record clock.
  assert.equal(modelOf(parse([...FIRST, ...SECOND]), { now: Date.parse(at(22)) + 11 * 60_000, busy: true }).status.kind, 'running');
});

test('waiting for an approval replaces the status line, marks the call and changes the title', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { extras: { approval: { tool: 'Bash', summary: 'grep -rn "assert.equal(expected" tests' } } });
  assert.equal(model.status.kind, 'waiting');
  const lines = text(turnBody(ctxOf(model, 1)));
  assert.equal(lines.at(-2), ' ▌ 等你批准  Bash · grep -rn "assert.equal(expected" tests');
  assert.equal(lines.at(-1), ' ▌ 在 Claude Code 里选择批准或拒绝。');
  assert.match(lines.at(-4)!, /Search for reversed assertions +\? → $/);
  assert.match(text(headerLines(ctxOf(model, 1)))[0], /⏸ 等你批准 $/);
  assert.equal(windowTitle(model), '⏸ 等你批准 — Sidecar · Claude Code');
});

test('text on screen but not yet in the transcript shows dim and italic before the status line', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { extras: { draft: '找到 3 处写反的断言，接下来逐个修正。' } });
  const lines = turnBody(ctxOf(model, 1));
  const draft = lines.at(-3)!;
  assert.equal(plainText(draft), '   找到 3 处写反的断言，接下来逐个修正。');
  assert.ok(spans(draft).filter(span => span.text.trim()).every(span => span.style?.dim && span.style.italic));
  // Not on an older turn.
  assert.ok(!text(turnBody(ctxOf(model, 0))).some(line => line.includes('找到 3 处')));
});

test('目录 lists the newest turn first, two lines each, with its state on the right', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  const entries = contentsEntries(model.groups, 'claude', model.status, ONE_CELL, model.now);
  assert.deepEqual(entries.map(entry => entry.index), [1, 0]);
  const lines = text(contentsLines(entries, 0, 62, ONE_CELL));
  assert.match(lines[0], /^ {3}再加一个回归测试.*… +运行中 $/);
  assert.match(lines[1], /^ {3}10s · 1 call · \d\d:\d\d$/);
  assert.equal(lines[2], '');
  assert.match(lines[3], /^ ❯ 先看看测试为什么失败，再修好它 +完成 $/);
  assert.match(lines[4], /^ {3}✻ \w+ for 14s · 4 calls · \d\d:\d\d$/);
});

test('following shows the newest turn and jumps to a new one; an older turn on screen gets a notice instead', () => {
  const first = modelOf(parse(FIRST));
  let state = update(initialState(), first);
  assert.equal(state.index, 0);
  // Following: a new turn takes over the screen.
  const both = modelOf(parse([...FIRST, ...SECOND]));
  state = update(state, both);
  assert.equal(state.index, 1);
  assert.equal(state.follow, true);
  // [ goes back and stops following; a third turn starting does not move the screen.
  state = key(state, keyOf('['), both);
  assert.deepEqual([state.index, state.follow], [0, false]);
  const third = modelOf(parse([...FIRST, ...SECOND, result('t5', 23), said('没有别的了。', 24, true), done(25, 5000), rec('user', '提交吧', 40), said('好。', 41)]), { now: Date.parse(at(45)) });
  state = update(state, third);
  assert.equal(state.index, 0);
  assert.equal(state.notice, 2);
  const bottom = text(frame(state, third)).slice(-2);
  assert.match(bottom[0], /^─+$/);
  assert.match(bottom[1], /^ ● 第 3 轮开始了：提交吧 +\] 跳到最新 $/);
  // ] jumps straight to the newest turn and follows again.
  state = key(state, keyOf(']'), third);
  assert.deepEqual([state.index, state.follow, state.notice], [2, true, undefined]);
});

const wheel = (action: 'wheelUp' | 'wheelDown'): InputEvent => ({ type: 'mouse', action, button: action === 'wheelUp' ? 64 : 65, x: 5, y: 5 });

test('scrolling up pauses following, G resumes it at the end of the newest turn', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { height: 6 });
  let state = update(initialState(), model);
  const end = state.scroll;
  assert.ok(end > 0, 'The turn is taller than the pane');
  state = key(state, wheel('wheelUp'), model);
  assert.deepEqual([state.follow, state.scroll], [false, Math.max(0, end - 3)]);
  assert.match(text(frame(state, model)).at(-1)!, /^ 已暂停跟随 · G 恢复 +t 目录 {3}↑↓ 选择 {3}\? 帮助 $/);
  // New records do not move a paused view.
  state = update(state, model);
  assert.equal(state.scroll, Math.max(0, end - 3));
  state = key(state, keyOf('G'), model);
  assert.deepEqual([state.follow, state.scroll], [true, end]);
  // Scrolling back down to the end follows again too.
  state = key(key(state, wheel('wheelUp'), model), wheel('wheelDown'), model);
  state = key(state, wheel('wheelDown'), model);
  assert.equal(state.follow, true);
});

test('↑↓ select calls, the selected one is marked; ⏎ opens it; selecting stops following', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  let state = key(update(initialState(), model), keyOf('['), model);
  assert.equal(state.index, 0);
  state = key(state, keyOf('down'), model);
  assert.deepEqual([state.call, state.follow], [0, false]);
  const lines = text(frame(state, model));
  // One marker only: no cursor in the margin, the row keeps its place.
  assert.ok(lines.some(line => /^ {5}Bash {3}Run the unit tests +exit 1 → $/.test(line)), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('›')));
  assert.match(lines.at(-1)!, /⏎ 详情/);
  state = key(key(state, keyOf('down'), model), keyOf('up'), model);
  assert.equal(state.call, 0);
  // The selected row: its arrow yellow, its tool name no longer dim, its label bold.
  const selected = spans(frame(state, model).find(line => text([line])[0].includes('Run the unit tests'))!);
  assert.equal(selected.find(span => span.text.trim() === '→')?.style?.fg, 'yellow');
  assert.equal(selected.find(span => span.text.trim() === 'Bash')?.style?.dim, false);
  assert.equal(selected.find(span => span.text === 'Run the unit tests')?.style?.bold, true);
  // ⏎ opens, Esc comes back; q quits from anywhere.
  state = key(state, keyOf('enter'), model);
  assert.equal(state.mode, 'detail');
  assert.equal(key(state, keyOf('q'), model).quit, true);
  state = key(state, keyOf('escape'), model);
  assert.deepEqual([state.mode, state.call], ['turn', 0]);
  // Esc on the turn page drops the selection.
  state = key(state, keyOf('escape'), model);
  assert.deepEqual([state.mode, state.call], ['turn', undefined]);
});

test('details: a call shows its input and return; a read shows the file; a change shows the diff; [ ] move between calls', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  let state = key(key(key(update(initialState(), model), keyOf('['), model), keyOf('down'), model), keyOf('enter'), model);
  let doc = openDetail(state, model)!;
  assert.deepEqual([doc.kind, doc.meta, doc.copy], ['call', 'Bash · exit 1', { text: 'npm test', what: '命令' }]);
  let lines = text(doc.lines);
  assert.equal(lines[0], ' 输入');
  assert.equal(lines[1], '      │ npm test');
  assert.ok(lines.includes(' 返回 · exit 1') && lines.includes('      │ AssertionError'), lines.join('\n'));
  // Every content line has the same shape: a left column, a bar, the text.
  assert.ok(lines.filter(line => line && !/^ \S/.test(line)).every(line => /^ .{4} │ /.test(line)), lines.join('\n'));
  assert.match(text(frame(state, model))[0], /^ ← Esc {2}Run the unit tests +Bash · exit 1 $/);
  state = key(key(state, keyOf(']'), model), keyOf(']'), model);
  doc = openDetail(state, model)!;
  assert.deepEqual([doc.kind, doc.title, doc.directory, doc.meta, doc.path, doc.line], ['file', 'width.ts', 'src/', 'Read · 第 1–1 行', '/fixture/src/width.ts', 1]);
  assert.deepEqual(text(doc.lines), ['    1 │ const a = 1;']);
  // The file is highlighted with palette colours.
  assert.ok(doc.lines[0].length > 2 && spans(doc.lines[0]).some(span => span.style?.fg === 'magenta'));
  assert.deepEqual(key(state, keyOf('o'), model).effect, { kind: 'open', path: '/fixture/src/width.ts', line: 1 });
  assert.deepEqual(key(state, keyOf('y'), model).effect, { kind: 'copy', text: '/fixture/src/width.ts', what: '路径' });
  state = key(state, keyOf(']'), model);
  doc = openDetail(state, model)!;
  assert.deepEqual([doc.kind, doc.title, doc.meta], ['diff', 'width.test.ts', 'Write']);
  assert.deepEqual(text(doc.lines), ['    - │ a', '    + │ b']);
  assert.equal(spans(doc.lines[0])[0].style?.fg, 'red');
  // The end of the turn's calls: ] stays.
  assert.equal(key(state, keyOf(']'), model).call, state.call);
  state = key(state, keyOf('['), model);
  assert.equal(openDetail(state, model)!.kind, 'file');
});

test('details: changes to the same file in one turn switch with < >', () => {
  const edits = parse([
    rec('user', '改两次', 0),
    call('e1', 'Edit', { file_path: '/fixture/a.ts', old_string: 'one', new_string: 'two' }, 1), result('e1', 2),
    call('e2', 'Read', { file_path: '/fixture/b.ts' }, 3), result('e2', 4, false, '1\tb'),
    call('e3', 'Edit', { file_path: '/fixture/a.ts', old_string: 'two', new_string: 'three' }, 5), result('e3', 6),
    said('改好了。', 7, true), done(8, 8000),
  ]);
  const model = modelOf(edits);
  let state = key(key(update(initialState(), model), keyOf('down'), model), keyOf('enter'), model);
  let doc = openDetail(state, model)!;
  assert.deepEqual([doc.meta, doc.edits, text(doc.lines)], ['Write · 第 1 次 / 共 2 次', { index: 0, total: 2 }, ['    - │ one', '    + │ two']]);
  state = key(state, keyOf('>'), model);
  doc = openDetail(state, model)!;
  assert.deepEqual([doc.meta, text(doc.lines)], ['Write · 第 2 次 / 共 2 次', ['    - │ two', '    + │ three']]);
  assert.match(text(frame(state, model)).at(-1)!, /< > 切换修改/);
  state = key(state, keyOf('<'), model);
  assert.equal(openDetail(state, model)!.edits!.index, 0);
});

test('details: arguments read as name: value rows inside the same panel; the description is left out', () => {
  const session = parse([
    rec('user', '找一下', 0),
    call('g1', 'Grep', { pattern: 'TODO', path: 'src', output_mode: 'content' }, 1), result('g1', 2, false, 'src/a.ts:1:TODO'),
    call('b1', 'Bash', { command: 'npm test', description: 'Run the tests', timeout: 30000 }, 3), result('b1', 4),
    said('好了。', 5, true), done(6, 6000),
  ]);
  const model = modelOf(session);
  let state = key(key(update(initialState(), model), keyOf('down'), model), keyOf('enter'), model);
  assert.deepEqual(text(openDetail(state, model)!.lines).slice(0, 4), [' 输入', '      │ 匹配: TODO', '      │ 路径: src', '      │ output_mode: content']);
  state = key(state, keyOf(']'), model);
  assert.deepEqual(text(openDetail(state, model)!.lines).slice(0, 3), [' 输入', '      │ npm test', '      │ timeout: 30000']);
});

test('a diff has + and - in the left column; hunk headers stay as text; a written file is all +', () => {
  const glyph = (ch: string) => ch;
  assert.deepEqual(text(diffLines({ path: 'a.ts', operation: 'update', lines: ['@@ -10,2 +10,3 @@', ' keep', '-old', '+new'] }, 60, glyph)), [
    '      │ @@ -10,2 +10,3 @@',
    '      │ keep',
    '    - │ old',
    '    + │ new',
  ]);
  assert.deepEqual(text(diffLines({ path: 'n.txt', operation: 'write', lines: ['x', 'y'] }, 60, glyph)), ['    + │ x', '    + │ y']);
});

test('a message covers the bottom lines, wrapped, until it expires', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { width: 30, height: 12 });
  const state = { ...update(initialState(), model), message: { text: '这个终端不能直接复制，请手动复制：npm test -- --grep width', until: model.now + 1000 } };
  const lines = text(frame(state, model));
  assert.equal(lines.length, 12);
  assert.match(lines.at(-4)!, /^─+$/);
  assert.deepEqual(lines.slice(-3), [' 这个终端不能直接复制，请手动', ' 复制：npm test -- --grep', ' width']);
  assert.ok(!text(frame({ ...state, message: { ...state.message, until: model.now - 1 } }, model)).some(line => line.includes('手动复制')));
});

test('details: a read keeps its last empty line, a call drops arguments that only repeat its description, hints fit the footer', () => {
  assert.deepEqual(text(fileLines({ lines: ['one', 'two', ''], start: 1 }, 40, ch => ch)), ['    1 │ one', '    2 │ two', '    3 │ ']);
  const model = modelOf(parse([...FIRST, ...SECOND]));
  const state = key(key(key(update(initialState(), model), keyOf('['), model), keyOf('down'), model), keyOf('enter'), model);
  assert.ok(!text(openDetail(state, model)!.lines).some(line => line.includes('description')));
  assert.equal(fitKeys(['< > 切换修改', 'o 在编辑器打开', 'y 复制路径', '[ ] 上/下一个调用'], 44), '< > 切换修改   o 在编辑器打开   y 复制路径');
  assert.equal(fitKeys(['', 'y 复制命令', '[ ] 上/下一个调用'], 60), 'y 复制命令   [ ] 上/下一个调用');
});

test('detail lines fit the pane: long code wraps under the gutter', () => {
  const reading = { lines: ['const value = "' + 'x'.repeat(80) + '";'], start: 7, language: 'typescript' };
  const lines = text(fileLines(reading, 40, ch => ch));
  assert.ok(lines.length > 1);
  assert.match(lines[0], /^ {4}7 │ const/);
  assert.match(lines[1], /^ {6}│ /);
  for (const line of lines) assert.ok(textWidth(line) <= 40, line);
});

test('目录 opens with t, moves with ↑↓ and opens a turn with ⏎', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  let state: AppState = update(initialState(), model);
  state = key(state, keyOf('t'), model);
  assert.deepEqual([state.mode, state.selected], ['contents', 1]);
  state = key(state, keyOf('down'), model);
  assert.equal(state.selected, 0);
  state = key(state, keyOf('enter'), model);
  assert.deepEqual([state.mode, state.index, state.follow], ['turn', 0, false]);
  // A click on "第 N 轮" opens it too.
  state = key(state, { type: 'mouse', action: 'press', button: 0, x: 3, y: 2 }, model);
  assert.equal(state.mode, 'contents');
  state = key(state, keyOf('escape'), model);
  assert.equal(state.mode, 'turn');
  assert.equal(key(state, keyOf('q'), model).quit, true);
});

const plain = (lines: Line[]) => lines.map(line => spans(line).map(span => span.text).join(''));
const styleOf = (lines: Line[], text: string) => lines.flatMap(spans).find(span => span.text.includes(text))?.style ?? {};

test('prose: inline styles — code colour, bold, italic, strike; links show their address', () => {
  const lines = prose('改 `chapterTurn`、**两处**、*斜体*、~~删掉~~，见 [文档](https://example.com/doc) 和 [https://a.b](https://a.b)。', 120, { indent: 0 });
  assert.deepEqual(plain(lines), ['改 chapterTurn、两处、斜体、删掉，见 文档 (https://example.com/doc) 和 https://a.b。']);
  assert.equal(styleOf(lines, 'chapterTurn').fg, 'cyan');
  assert.equal(styleOf(lines, '两处').bold, true);
  assert.equal(styleOf(lines, '斜体').italic, true);
  assert.equal(styleOf(lines, '删掉').strike, true);
  assert.equal(styleOf(lines, '文档').underline, true);
  assert.equal(styleOf(lines, '(https://example.com/doc)').dim, true);
  // Never a clickable link: transcript links are references, as in the VS Code panel.
  assert.ok(lines.flatMap(spans).every(span => !span.style?.link));
  assert.deepEqual(plain(prose('看图 ![截图](a.png)', 40, { indent: 0 })), ['看图 [图片引用：截图 · 未加载]']);
});

test('prose: styles survive wrapping; a line break in the source stays a break', () => {
  const wrapped = wrapSpans(inlineSpans('一二三四五 `code-name` 六七八九十'), 12);
  assert.deepEqual(wrapped.map(line => line.map(span => span.text).join('')), ['一二三四五', 'code-name 六', '七八九十']);
  assert.deepEqual(wrapped[1].map(span => [span.text, span.style?.fg]), [['code-name', 'cyan'], [' 六', undefined]]);
  assert.deepEqual(plain(prose('第一行\n第二行', 40, { indent: 2 })), ['  第一行', '  第二行']);
});

test('prose: headings, lists, task lists, quotes, rules and code blocks', () => {
  const source = '# 标题\n\n要改的有：\n- 插件目录和两份清单，以及安装脚本\n- 测试\n  - 单元测试\n\n1. 第一\n2. 第二\n\n- [ ] 待办\n- [x] 已办\n\n> 引用一行\n\n---\n\n```js\nconst a = 1; // 很长很长很长很长很长的注释\n```';
  const lines = prose(source, 30, { indent: 3 });
  assert.deepEqual(plain(lines), [
    '   标题', '',
    '   要改的有：', '',
    '   - 插件目录和两份清单，以及',
    '     安装脚本',
    '   - 测试',
    '     - 单元测试', '',
    '   1. 第一',
    '   2. 第二', '',
    '   ☐ 待办',
    '   ☑ 已办', '',
    '   │ 引用一行', '',
    '   ───────────────────────────', '',
    '     const a = 1; // 很长很长…',
  ]);
  assert.deepEqual([styleOf(lines, '标题').bold, styleOf(lines, '标题').underline], [true, true]);
  // A fence that names its language is highlighted.
  assert.equal(styleOf(lines, 'const').fg, 'magenta');
  for (const line of lines) assert.ok(textWidth(plainText(line)) <= 30, plainText(line));
  // Where a symbol is not one cell wide, its ASCII stand-in is drawn.
  const ascii = plain(prose('- [ ] 待办\n\n> 引用', 30, { indent: 0, glyph: ch => ({ '☐': '[ ]', '│': '|' } as Record<string, string>)[ch] ?? ch }));
  assert.deepEqual(ascii, ['[ ] 待办', '', '| 引用']);
});

const TABLE = '| 文件 | 内容 | 行数 |\n|---|---|--:|\n| `fruits.txt` | apple、banana、cherry | 3 |\n| `numbers.txt` | one、two | 2 |';

test('prose: a table gets borders, a bold header and its column alignment', () => {
  const lines = prose(TABLE, 60, { indent: 0 });
  assert.deepEqual(plain(lines), [
    '┌─────────────┬───────────────────────┬──────┐',
    '│ 文件        │ 内容                  │ 行数 │',
    '├─────────────┼───────────────────────┼──────┤',
    '│ fruits.txt  │ apple、banana、cherry │    3 │',
    '│ numbers.txt │ one、two              │    2 │',
    '└─────────────┴───────────────────────┴──────┘',
  ]);
  assert.equal(styleOf(lines, '文件').bold, true);
  assert.equal(styleOf(lines, '┌').dim, true);
  assert.equal(styleOf(lines, 'fruits.txt').fg, 'cyan');
});

test('prose: a table too wide wraps inside its cells; too narrow for that, it becomes records', () => {
  const lines = prose(TABLE, 36, { indent: 0 });
  for (const line of lines) assert.equal(textWidth(plainText(line)), 36, plainText(line));
  // Narrow columns keep their width; the wide one takes what is left and wraps.
  assert.deepEqual(plain(lines).slice(3, 7), [
    '│ fruits.txt  │ apple、     │    3 │',
    '│             │ banana、    │      │',
    '│             │ cherry      │      │',
    '│ numbers.txt │ one、two    │    2 │',
  ]);
  const records = plain(prose(TABLE, 20, { indent: 2 }));
  assert.deepEqual(records.slice(0, 7), ['  文件', '    fruits.txt', '  内容', '    apple、banana、', '    cherry', '  行数', '    3']);
  assert.ok(records.includes(''), 'Records are a blank line apart');
});

test('table columns: narrow ones keep their width, the rest share what is left', () => {
  assert.deepEqual(columnWidths([10, 30, 4], 30), [10, 16, 4]);
  assert.equal(columnWidths([10, 10, 10, 10], 12), undefined);
});

test('the running clock reads like the agents’', () => {
  assert.deepEqual([8_000, 65_000, 245_000, 3_725_000].map(runningClock), ['8s', '1m 05s', '4m 05s', '1h 02m']);
});
