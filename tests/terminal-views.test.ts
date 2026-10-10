import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';
import { parseCodex } from '../packages/core/src/codex';
import { resolveOutlineEvidence, visibleTurnGroups } from '../packages/core/src/outline';
import { turnView } from '../packages/core/src/turn-view';
import type { SessionData } from '../packages/core/src/model';
import type { LiveExtras } from '../packages/core/src/live-extras';
import { SYMBOLS } from '../packages/terminal/src/caps';
import { fitKeys, frame, initialState, key, openDetail, pointerGone, pointerRest, update, windowTitle, type AppState, type Model } from '../packages/terminal/src/app';
import { changedWords, diffLines, fileLines } from '../packages/terminal/src/views/detail';
import { InputParser, type InputEvent } from '../packages/terminal/src/input';
import { plainText, spans, type Line } from '../packages/terminal/src/screen';
import { contentsEntries, contentsLines } from '../packages/terminal/src/views/contents';
import { columnWidths, inlineSpans, prose, wrapSpans } from '../packages/terminal/src/views/prose';
import { exploreText } from '../packages/core/src/command-line';
import { liveExtras } from '../packages/core/src/live-extras';
import type { SessionState } from '../packages/core/src/session-state';
import { commandText, headerLines, runningClock, sessionStatus, turnBody, type PageContext } from '../packages/terminal/src/views/turn-page';
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

test('a finished turn: the request as title, its changes, each step\'s words, its calls as a tree under them, the answer after its label', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  const body = turnBody(ctxOf(model, 0));
  const lines = text(body);
  assert.deepEqual(lines.map(line => line.trimEnd()), [
    '  Prompt',
    '┃ 先看看测试为什么失败，再修好它',
    '  改动  M width.test.ts',
    '',
    '  先跑一遍测试，看失败在哪一步。',
    '',
    '  Bash',
    '  ├ Run the unit tests exit 1',
    '  └ Run only the width tests',
    '  Read',
    '  └ width.ts',
    '',
    '  断言写反了：期望值和实际值调换了位置。改正后重跑：',
    '',
    '  Edit',
    '  └ width.test.ts +1 -1',
    '',
    '  Final Answer',
    '  修好了：assert.equal 的两个参数写反了。 ▾',
  ]);
  // The prompt under its label, a blue bar beside it; the words in the body colour; the tool names bold in the body colour, to see what was used;
  // what each call worked on grey, all alike, and the tree grey.
  assert.deepEqual(spans(body[0]).find(span => span.text.includes('Prompt'))?.style, { fg: 'blue', bold: true });
  assert.equal(spans(body[1]).find(span => span.text === '┃')?.style?.fg, 'blue');
  assert.ok(spans(body[4]).filter(span => span.text.includes('先跑')).every(span => !span.style?.dim));
  assert.ok(spans(body[6]).some(span => span.text === 'Bash' && !span.style?.dim && span.style?.bold));
  assert.ok(spans(body[7]).some(span => span.text.includes('├') && span.style?.dim));
  assert.ok(spans(body[8]).some(span => span.text === 'Run only the width tests' && span.style?.dim));
  assert.ok(spans(body[10]).filter(span => span.text.trim()).every(span => span.style?.dim));
  assert.ok(spans(body[7]).some(span => span.text === 'exit 1' && span.style?.fg === 'red'));
  assert.ok(spans(body[15]).some(span => span.text === 'width.test.ts' && span.style?.dim));
  assert.ok(spans(body[15]).some(span => span.text === '+1' && span.style?.fg === 'green'));
  // The answer's label on a line of its own, over the answer, as the prompt's is.
  assert.deepEqual(spans(body[17]).find(span => span.text.includes('Final Answer'))?.style, { fg: 'green', bold: true });
  assert.ok(!lines.some(line => /→|✻|●|[$≡±]|calls/.test(line)));
});

test('reads in a row hang from one Read, one per line; each is its own call to select and to click', () => {
  const session = parse([
    rec('user', '看看这几个文件', 0),
    call('r1', 'Read', { file_path: '/fixture/a.ts' }, 1), result('r1', 2, false, '1\tx'),
    call('r2', 'Read', { file_path: '/fixture/b.ts' }, 3), result('r2', 4, false, '1\ty'),
    call('r3', 'Read', { file_path: '/fixture/c.ts' }, 5), result('r3', 6, false, '1\tz'),
    said('看完了。', 7, true), done(8, 8000),
  ]);
  const model = modelOf(session);
  const lines = text(turnBody(ctxOf(model, 0)));
  assert.deepEqual(lines.slice(3, 7).map(line => line.trimEnd()), ['  Read', '  ├ a.ts', '  ├ b.ts', '  └ c.ts']);
  let state = key(update(initialState(), model), keyOf('down'), model);
  state = key(state, keyOf('down'), model);
  assert.equal(state.call, 1);
  const marked = frame(state, model).find(line => plainText(line).includes('b.ts'))!;
  assert.equal(spans(marked).find(span => span.text === 'b.ts')?.style?.fg, 'yellow');
  assert.notEqual(spans(marked).find(span => span.text.includes('├'))?.style?.fg, 'yellow', 'The tree stays grey');
  // A click on a line opens its call.
  const y = text(frame(state, model)).findIndex(line => line.includes('c.ts')) + 1;
  state = key(state, { type: 'mouse', action: 'press', button: 0, x: 5, y }, model);
  assert.deepEqual([state.mode, state.call], ['detail', 2]);
});

test('a command reads as what it runs: set-up dropped, paths shortened, one line, the rest counted', () => {
  assert.deepEqual(commandText('cd /p/x && S=unix:/tmp/k; kitten @ --to $S ls | head; echo ---; tmux kill-server', '/p'), { text: 'kitten @ --to $S ls', more: 1 });
  assert.deepEqual(commandText('T() { tmux -L t "$@"; }; T send-keys Enter'), { text: 'T send-keys Enter', more: 0 });
  assert.deepEqual(commandText('echo "it\'s"'), { text: 'echo "it\'s"', more: 0 });
  // Printing, waiting and loop words around the work are not the work.
  assert.deepEqual(commandText('pwd; git status --short; git log --oneline -8'), { text: 'git status --short', more: 1 });
  assert.deepEqual(commandText('for i in 1 2 3; do\n  kitten @ get-text --match id:$i\ndone'), { text: 'kitten @ get-text --match id:$i', more: 0 });
  // A value got by running a command: that command is the work. Variables set for one command are not.
  assert.deepEqual(commandText('S=x; p=$(kitten @ launch --type=window cat); echo probe=$p'), { text: 'kitten @ launch --type=window cat', more: 0 });
  assert.deepEqual(commandText('PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v'), { text: 'python3 -m unittest -v', more: 0 });
  assert.deepEqual(commandText('command -v codex; which -a codex'), { text: 'command -v codex', more: 1 });
  // What only cuts the output down, and where errors go, are left off.
  assert.deepEqual(commandText('node --test dist/a.test.js 2>&1 | grep -E "fail" | head -20'), { text: 'node --test dist/a.test.js | grep -E "fail"', more: 0 });
});

test('a file shown again after it changed outside the agent\'s edits is no call in the tree', () => {
  const fragment = { type: 'attachment', uuid: `u${++uuid}`, timestamp: at(3), sessionId: 'cl', cwd: '/fixture', attachment: { type: 'edited_text_file', filename: '/fixture/src/width.ts', snippet: '1\tconst a = 2;' } };
  const session = parse([rec('user', '改一下', 0), call('f1', 'Bash', { command: "python3 - <<'EOF'\np='src/width.ts'\nEOF" }, 1), result('f1', 2), fragment, said('改好了。', 4, true), done(5, 5000)]);
  const lines = text(turnBody(ctxOf(modelOf(session, { width: 62 }), 0)));
  assert.ok(lines.some(line => line.includes('python3 · width.ts')));
  assert.ok(!lines.some(line => /^\s*Write\s*$/.test(line)));
});

test('a command that only looks at files goes by Read, Search or List; one that does more stays Bash', () => {
  assert.deepEqual(exploreText(`rg -n 'Claude.*实战|agent-session-handoff' -g '*.md' -g '!runs/**' .`), { tool: 'Search', text: 'Claude.*实战|agent-session-handoff', more: 0 });
  assert.deepEqual(exploreText('grep -rn -e "131072" -e "128 \\* 1024" packages | grep -v node_modules'), { tool: 'Search', text: '131072|128 * 1024 in packages', more: 0 });
  assert.deepEqual(exploreText('rg --files -g AGENTS.md -g README.md /x/ios-agent-build'), { tool: 'List', text: 'AGENTS.md, README.md in ios-agent-build', more: 0 });
  assert.deepEqual(exploreText('find src -name "*.ts" -type f | head'), { tool: 'List', text: '*.ts in src', more: 0 });
  assert.deepEqual(exploreText('ls -la plugins/sidecar-split/'), { tool: 'List', text: 'sidecar-split', more: 0 });
  // Looks of one kind together, then the rest counted.
  assert.deepEqual(exploreText('sed -n 110,150p /m/MEMORY.md; cat a/b.md; rg -n x src'), { tool: 'Read', text: 'MEMORY.md:110-150, b.md', more: 1 });
  // Anything that writes, runs, counts or expands is not a look.
  for (const command of ['cat a.md; npm test', 'grep -n x a.ts | wc -l', 'ls -la $(which claude)', 'cat a.md > b.md', 'sed -i 1d a.md', 'cat --unknown a.md', 'find . -name "*.tmp" -delete', 'git status --short'])
    assert.equal(exploreText(command), undefined, command);
});

test('a script reads by what it works on; reads by their files and lines', () => {
  // Whether it changes the files it names, or only reads them.
  assert.deepEqual(commandText("cd /p && python3 - <<'EOF'\nimport re\np='packages/x/turn-page.ts'; s=open(p).read()\nopen(p,'w').write(s)\nEOF"), { text: 'python3 · edits turn-page.ts', more: 0 });
  assert.deepEqual(commandText("python3 - \"$SP/page.html\" <<'EOF'\nimport sys\np=sys.argv[1]\nEOF"), { text: 'python3 · page.html', more: 0 });
  assert.deepEqual(commandText(`python3 -B -c 'import json; from pathlib import Path; s=json.loads(Path("runs/state.json").read_text()); print(s["status"])'`), { text: 'python3 -c · state.json', more: 0 });
  assert.deepEqual(commandText("python3 - <<'PY'\nimport urllib.request\nurllib.request.urlopen('https://api.github.com/x')\nPY\nls"), { text: 'python3 · api.github.com', more: 1 });
  assert.deepEqual(commandText("python3 - <<'EOF'\nimport json\nprint(1)\nEOF"), { text: 'python3 · print(1)', more: 0 });
  assert.deepEqual(commandText("git commit -q -F - <<'EOF'\nTerminal: one column\n\nBody\nEOF"), { text: 'git commit · Terminal: one column', more: 0 });
  assert.deepEqual(commandText('node -e "\nconst fs = require(\'fs\');\nfs.readFileSync(\'a/b.json\')\n"'), { text: 'node -e · b.json', more: 0 });
  // A read keeps its command: what it did, then the files and lines.
  assert.deepEqual(commandText('sed -n 1,9p /h/a/b.ts', '', '/h'), { text: 'sed b.ts:1-9', more: 0 });
  assert.deepEqual(commandText('head -12 a/x.ts; cat a/y.md | head -5; cat a/z.md; npm test'), { text: 'head x.ts:1-12; cat y.md, z.md', more: 1 });
  assert.deepEqual(commandText('tail -40 ~/log/split.log'), { text: 'tail split.log', more: 0 });
  // A long quoted program or pattern is cut short, so what it runs on still reads.
  assert.deepEqual(commandText(`jq -c '{type, timestamp, p: (.payload | del(.encrypted_content) | tostring)}' f.jsonl`), { text: `jq -c '{type, timestamp, p: (.payload |…' f.jsonl`, more: 0 });
});

test('a long call label wraps to two lines at most, the second under the tree', () => {
  const session = parse([
    rec('user', '跑一下', 0),
    call('l1', 'Bash', { command: 'true', description: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen' }, 1), result('l1', 2),
    said('好了。', 3, true), done(4, 4000),
  ]);
  const all = text(turnBody(ctxOf(modelOf(session, { width: 30 }), 0)));
  const lines = all.slice(4, 6);
  assert.equal(all[3].trimEnd(), '  Bash');
  assert.equal(all[6], '');
  assert.match(lines[0], /^  └ one two/);
  assert.match(lines[1].trimEnd(), /^ {4}\S.*…$/);
});
test('the running turn shows no agent word or clock and no end; a call still out is marked', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  assert.equal(model.status.kind, 'running');
  const body = turnBody(ctxOf(model, 1));
  const lines = text(body);
  assert.equal(lines.at(-2)!.trimEnd(), '  Search');
  assert.match(lines.at(-1)!, /^  └ Search for reversed assertions … *$/);
  assert.equal(spans(body.at(-1)!).find(span => span.text === '…')?.style?.fg, 'yellow');
  assert.ok(!lines.some(line => line.includes('答复')));
  const header = text(headerLines(ctxOf(model, 1)));
  assert.equal(header.length, 1);
  assert.doesNotMatch(header[0], /运行中|\d+s|Claude Code/);
  assert.match(header[0], /^  第 2 轮 \/ 共 2 轮 · \d\d:\d\d 开始$/);
});
test('a quiet open turn is not called running', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { now: Date.parse(at(22)) + 11 * 60_000 });
  assert.equal(model.status.kind, 'quiet');
  assert.match(text(turnBody(ctxOf(model, 1))).at(-1)!, /^  无新记录 · 最后一条 \d\d:\d\d$/);
  // The agent's own word wins over the record clock.
  assert.equal(modelOf(parse([...FIRST, ...SECOND]), { now: Date.parse(at(22)) + 11 * 60_000, busy: true }).status.kind, 'running');
});

test('waiting for an approval replaces the status line, marks the call and changes the title', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { extras: { approval: { tool: 'Bash', summary: 'grep -rn "assert.equal(expected" tests' } } });
  assert.equal(model.status.kind, 'waiting');
  const lines = text(turnBody(ctxOf(model, 1)));
  // As Final Answer is: the label on its own line, what it asks about under it.
  assert.equal(lines.at(-3), '  Needs approval');
  assert.match(lines.at(-2)!, /^ {2}Bash · grep -rn "assert/);
  assert.equal(lines.at(-1), '  在 Claude Code 里选择批准或拒绝。');
  assert.match(lines.at(-5)!, /^  └ Search for reversed assertions \? *$/);
  assert.match(text(headerLines(ctxOf(model, 1)))[0], / Needs approval *$/);
  // Claude Code says when it stops waiting: an approved command that runs for a while is no longer waiting on you.
  const groups = model.groups, latest = turnView(groups.at(-1)!, true, 'claude');
  assert.equal(sessionStatus(latest, model.extras, model.now, { busy: true, state: 'busy' }).kind, 'running');
  assert.equal(sessionStatus(latest, model.extras, model.now, { busy: true, state: 'waiting' }).kind, 'waiting');
  assert.equal(windowTitle(model), '⏸ 等你批准 — Sidecar · Claude Code');
});

test('a call on screen but not yet in the transcript shows as it will, once', () => {
  const session = parse([...FIRST, ...SECOND]);
  const state: SessionState = { provider: 'claude', session: 'cl', cwd: '/fixture', agentPid: process.pid, hostPid: 1, startedAt: 0, activeAt: 0, phase: 'idle',
    calls: [
      { tool: 'Bash', input: { command: 'grep -rn "assert.equal(expected" tests', description: 'Search for reversed assertions' }, at: Date.parse(at(22)) },
      { tool: 'Bash', input: { command: 'npm test -- --grep regression', description: 'Run the regression test' }, at: Date.parse(at(23)) },
    ] };
  // The first call is in the transcript already: only the second is still out.
  const extras = liveExtras(session, state, Date.parse(at(24)));
  assert.deepEqual(extras.calls?.map(call => call.input.description), ['Run the regression test']);
  const lines = text(turnBody(ctxOf(modelOf(session, { extras, now: Date.parse(at(24)) }), 1)));
  assert.equal(lines.filter(line => line.includes('Search for reversed assertions')).length, 1, lines.join('\n'));
  assert.match(lines.find(line => line.includes('Run the regression test'))!, /^  └ Run the regression test … *$/);
});

test('text on screen but not yet in the transcript shows as the words will, so nothing changes when the record arrives', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { extras: { draft: '找到 3 处写反的断言，接下来逐个修正。' } });
  const lines = turnBody(ctxOf(model, 1));
  const draft = lines.at(-1)!;
  assert.equal(plainText(draft), '  找到 3 处写反的断言，接下来逐个修正。');
  assert.ok(spans(draft).filter(span => span.text.trim()).every(span => !span.style?.dim && !span.style?.italic));
  // Not on an older turn.
  assert.ok(!text(turnBody(ctxOf(model, 0))).some(line => line.includes('找到 3 处')));
});

test('目录 lists the newest turn first, two lines each: the request, then the answer’s first line or the turn’s state', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  const entries = contentsEntries(model.groups, 'claude', model.status, ONE_CELL, model.now);
  assert.deepEqual(entries.map(entry => entry.index), [1, 0]);
  const lines = contentsLines(entries, 0, 62, ONE_CELL);
  assert.match(plainText(lines[0]), /^  2 再加一个回归测试.*… +\d\d:\d\d {3}$/);
  assert.equal(plainText(lines[1]).trimEnd(), '    运行中');
  assert.equal(plainText(lines[2]), '');
  // The selected one is golden and ends in ⏎, as a selected call does.
  assert.match(plainText(lines[3]), /^  1 先看看测试为什么失败，再修好它 +\d\d:\d\d ⏎ $/);
  assert.equal(spans(lines[3]).find(span => span.text.includes('先看看'))?.style?.fg, 'yellow');
  assert.equal(plainText(lines[4]).trimEnd(), '    修好了：assert.equal 的两个参数写反了。');
  assert.ok(!text(lines).some(line => /完成|calls|\ds\b/.test(line)));
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
  // A label in a block of colour, as 答复 is, then what was asked.
  const notice = frame(state, third).at(-1)!;
  assert.equal(plainText(notice).trimEnd(), '  New turn 提交吧');
  assert.deepEqual(spans(notice).find(span => span.text.includes('New turn'))?.style, { fg: 'yellow', bold: true });
  // A click on the notice, or 】 from a Chinese input method, does what ] does.
  const noticeY = text(frame(state, third)).length;
  assert.deepEqual([key(state, { type: 'mouse', action: 'press', button: 0, x: 3, y: noticeY }, third).index, key(state, { type: 'mouse', action: 'press', button: 0, x: 3, y: noticeY - 1 }, third).index], [2, 0]);
  assert.equal(key(state, new InputParser().feed('】')[0], third).index, 2);
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
  assert.match(text(frame(state, model))[0], /^  第 2 轮.* 已暂停跟随 · G {3}\? 按键 $/);
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

test('↑↓ select calls and the answer; the selected one comes up golden and underlined, every line of it; ⏎ opens it; selecting stops following', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  let state = key(update(initialState(), model), keyOf('['), model);
  assert.equal(state.index, 0);
  state = key(state, keyOf('down'), model);
  assert.deepEqual([state.call, state.follow], [0, false]);
  let screen = frame(state, model);
  const lines = text(screen);
  // The row keeps its place: no cursor in the margin, no mark at the end.
  assert.ok(lines.some(line => /^  ├ Run the unit tests exit 1 *$/.test(line)), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('⏎ ') && !line.startsWith('  第')), 'No ⏎ on the call');
  assert.match(lines[0], /⏎ 详情/);
  const selected = spans(screen.find(line => text([line])[0].includes('Run the unit tests'))!);
  assert.notEqual(selected.find(span => span.text.includes('├'))?.style?.fg, 'yellow', 'The tree stays grey');
  assert.deepEqual([selected.find(span => span.text === 'Run the unit tests')?.style?.fg, selected.find(span => span.text === 'Run the unit tests')?.style?.dim], ['yellow', false]);
  assert.equal(selected.find(span => span.text === 'Run the unit tests')?.style?.underline, true);
  state = key(key(state, keyOf('down'), model), keyOf('up'), model);
  assert.equal(state.call, 0);
  // ⏎ opens, Esc comes back; q quits from anywhere.
  state = key(state, keyOf('enter'), model);
  assert.equal(state.mode, 'detail');
  assert.equal(key(state, keyOf('q'), model).quit, true);
  state = key(state, keyOf('escape'), model);
  assert.deepEqual([state.mode, state.call], ['turn', 0]);
  // The last target is the folded answer: ⏎ opens it in place, and again folds it.
  state = key(key(key(key(state, keyOf('down'), model), keyOf('down'), model), keyOf('down'), model), keyOf('down'), model);
  assert.match(text(frame(state, model))[0], /⏎ 展开/);
  state = key(state, keyOf('enter'), model);
  assert.deepEqual([state.mode, state.answerOpen], ['turn', true]);
  screen = frame(state, model);
  assert.ok(text(screen).some(line => line.startsWith('  修好了')));
  assert.equal(key(state, keyOf('enter'), model).answerOpen, false);
  // Esc on the turn page drops the selection.
  state = key(state, keyOf('escape'), model);
  assert.deepEqual([state.mode, state.call], ['turn', undefined]);
});

test('with a known background, a run of calls sits on a full-width band a little lighter than it', () => {
  const model = { ...modelOf(parse([...FIRST, ...SECOND])), caps: { ...ONE_CELL, background: { r: 10, g: 12, b: 16, dark: true } } };
  const body = turnBody(ctxOf(model, 0));
  const call = body.find(line => text([line])[0].includes('Run only the width tests'))!;
  assert.equal(textWidth(plainText(call)), model.width);
  assert.ok(spans(call).every(span => span.style?.bgRgb?.join() === '27,29,33'));
  // The words around it are not on the band.
  assert.ok(spans(body[3]).every(span => !span.style?.bgRgb));
});

test('the pointer brings up the call under it; one click opens it', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  let state = key(update(initialState(), model), keyOf('['), model);
  const y = text(frame(state, model)).findIndex(line => line.includes('Run only the width tests')) + 1;
  state = key(state, { type: 'mouse', action: 'move', button: 3, x: 10, y }, model);
  const screen = frame(state, model);
  assert.equal(spans(screen[y - 1]).find(span => span.text === 'Run only the width tests')?.style?.underline, true);
  assert.match(text(screen)[0], /⏎ 详情/);
  assert.equal(state.call, undefined);
  state = key(state, { type: 'mouse', action: 'press', button: 0, x: 10, y }, model);
  assert.deepEqual([state.mode, state.call], ['detail', 1]);
});

test('following an open turn keeps its end on screen; when it ends, the page goes back to its start', () => {
  const open = modelOf(parse([...FIRST, ...SECOND]), { height: 5 });
  let state = update(update(initialState(), modelOf(parse(FIRST), { height: 8 })), open);
  assert.ok(state.scroll > 0);
  const closed = modelOf(parse([...FIRST, ...SECOND, result('t5', 23), said('没有别的了。', 24, true), done(25, 5000)]), { height: 8, now: Date.parse(at(26)) });
  state = update(state, closed);
  assert.deepEqual([state.index, state.scroll, state.follow], [1, 0, true]);
  assert.ok(text(frame(state, closed)).some(line => line.startsWith('┃ 再加一个回归测试')));
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
  assert.match(text(frame(state, model))[0], /^  ← Esc {2}Run the unit tests +Bash · exit 1 $/);
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
  assert.deepEqual([doc.kind, doc.title, doc.meta], ['diff', 'width.test.ts', 'Edit']);
  assert.deepEqual(text(doc.lines), [' - a', ' + b']);
  assert.equal(spans(doc.lines[0]).find(span => span.text.trim() === '-')?.style?.fg, 'red');
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
  assert.deepEqual([doc.meta, doc.edits, text(doc.lines)], ['Edit · 第 1 次 / 共 2 次', { index: 0, total: 2 }, [' - one', ' + two']]);
  state = key(state, keyOf('>'), model);
  doc = openDetail(state, model)!;
  assert.deepEqual([doc.meta, text(doc.lines)], ['Edit · 第 2 次 / 共 2 次', [' - two', ' + three']]);
  assert.match(text(frame(state, model))[1], /< > 切换修改/);
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

test('a diff reads as Claude Code draws one: line numbers, the sign, red and green across the pane, the changed words brighter', () => {
  const glyph = (ch: string) => ch;
  const file = { path: 'a.ts', operation: 'update' as const, lines: ['@@ -10,2 +10,2 @@', ' keep', '-const narrow = ctx.width < 50;', '+const narrow = ctx.width < 40;', '@@ -40,1 +40,1 @@ function tail()', '-a', '+b'] };
  assert.deepEqual(text(diffLines(file, 40, glyph)).map(line => line.trimEnd()), [
    ' 10   keep',
    ' 11 - const narrow = ctx.width < 50;',
    ' 11 + const narrow = ctx.width < 40;',
    '      function tail()',
    ' 40 - a',
    ' 40 + b',
  ]);
  // Without a known background the colour is on the text; with one, the line is on red or green to the edge, the changed word brighter.
  assert.equal(spans(diffLines(file, 40, glyph)[2]).find(span => span.text.includes('narrow'))?.style?.fg, 'green');
  const dark = diffLines(file, 40, glyph, { r: 24, g: 25, b: 28, dark: true });
  assert.equal(textWidth(plainText(dark[2])), 40);
  assert.deepEqual(spans(dark[2]).at(-1)?.style?.bgRgb, [34, 92, 43]);
  assert.deepEqual(spans(dark[2]).find(span => span.text === '40')?.style?.bgRgb, [56, 166, 96]);
  assert.deepEqual(spans(dark[1]).find(span => span.text === '50')?.style?.bgRgb, [179, 89, 107]);
  assert.equal(spans(dark[0]).some(span => span.style?.bgRgb), false, 'A kept line has no colour');
  // A line rewritten through is the change as a whole: no word marks.
  assert.equal(changedWords('one', 'two'), undefined);
  // A Codex patch has no line numbers: the column is left out. A written file counts from 1.
  assert.deepEqual(text(diffLines({ path: 'b.ts', operation: 'update', lines: ['@@', '-x', '+y'] }, 40, glyph)).map(line => line.trimEnd()), [' - x', ' + y']);
  assert.deepEqual(text(diffLines({ path: 'n.txt', operation: 'write', lines: ['x', 'y'] }, 40, glyph)).map(line => line.trimEnd()), [' 1 + x', ' 2 + y']);
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
  state = key(state, { type: 'mouse', action: 'press', button: 0, x: 3, y: 1 }, model);
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

test('a focuses the agent only where the split adapter said how, and the help page says so', () => {
  const plain = modelOf(parse([...FIRST, ...SECOND]));
  const split = { ...plain, focusAgent: true };
  const state = update(initialState(), plain);
  assert.equal(key(state, keyOf('a'), plain).effect, undefined);
  assert.deepEqual(key(state, keyOf('a'), split).effect, { kind: 'focus' });
  assert.deepEqual(key({ ...state, mode: 'contents' }, keyOf('a'), split).effect, { kind: 'focus' }, 'The same key on every page');
  // The key is on the help page only where it works; no page has a footer of keys.
  assert.ok(text(frame({ ...state, mode: 'help' }, split)).some(line => line.includes('切回 Agent')));
  assert.ok(!text(frame({ ...state, mode: 'help' }, plain)).some(line => line.includes('切回 Agent')));
  assert.ok(!text(frame(state, split)).some(line => line.includes('切回 Agent')));
});

/** A Codex turn in code mode: one script runs a command and a web search; an async question is answered mid-turn. */
function codexScriptTurn(): SessionData {
  const turn = 't-code';
  const line = (second: number, type: string, payload: object) => ({ timestamp: at(second), type, payload });
  const done = (second: number, item: object) => line(second, 'event_msg', { type: 'item_completed', turn_id: turn, item });
  const question = '酒店订单上的地址是什么？';
  const reply = `<send_user_message_question_reply>\n${JSON.stringify([{ answer: '在古城', question, questionItemId: JSON.stringify(['request_user_input_async', 'call_ask', 0]) }])}\n</send_user_message_question_reply>`;
  const said = (second: number, text: string, phase: string) => line(second, 'response_item', { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] });
  const records = [
    line(0, 'session_meta', { id: 'cx-code', cwd: '/fixture' }),
    line(0, 'event_msg', { type: 'task_started', turn_id: turn }),
    line(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我排一下行程' }] }),
    said(1, '先查酒店的位置。', 'commentary'),
    line(2, 'response_item', { type: 'custom_tool_call', call_id: 'call_script', name: 'exec', input: "text(await tools.exec_command({cmd:\"rg -n Trip /fixture/MEMORY.md\"}));\ntext(await tools.web__run({search_query:[{q:'古城 酒店'},{q:'古城 车程'}]}));" }),
    done(3, { type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'rg -n Trip /fixture/MEMORY.md'], cwd: '/fixture', status: 'completed', aggregated_output: '1:Trip', exit_code: 0 }),
    done(4, { type: 'Extension', kind: 'web.search', id: 'exec-2', query: '古城 酒店 ...', results: [{ type: 'text_result', title: 'Source', url: 'https://example.test' }] }),
    line(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_script', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '1:Trip\nSource' }] }),
    line(6, 'response_item', { type: 'function_call', call_id: 'call_ask', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [{ title: question }] }) }),
    done(6, { type: 'AgentMessage', id: 'call_ask', phase: 'final_answer', delivery: 'async', content: [{ type: 'Text', text: question }], questions: [{ title: question, options: null }] }),
    line(7, 'response_item', { type: 'function_call_output', call_id: 'call_ask', output: '{"accepted":true}' }),
    line(8, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] }),
    done(8, { type: 'UserMessage', id: 'u-reply', content: [{ type: 'Text', text: reply }] }),
    said(9, '酒店在古城，行程这样排：', 'final_answer'),
    line(10, 'event_msg', { type: 'task_complete', turn_id: turn }),
  ];
  return parseCodex({ file: '/fixture/rollout-cx-code.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
}

test('a Codex script reads as its steps: the command, the first query, the question with its answer', () => {
  const session = codexScriptTurn();
  const model = { ...modelOf(session, { width: 48 }), status: { kind: 'idle' as const } };
  const page = text(turnBody(ctxOf(model, 0)));
  const joined = page.join('\n');
  // A command that only searches goes by Search, with what it looked for and where; the queries after the first are counted.
  const at = (text: string) => page.findIndex(line => line.includes(text));
  assert.ok(at('Trip in MEMORY.md') > 0 && page[at('Trip in MEMORY.md') - 1].trim() === 'Search', joined);
  assert.ok(at('古城 酒店 +1') > 0 && page[at('古城 酒店 +1') - 1].trim() === 'WebSearch', joined);
  // The script's shared output and the search's sources are records of those steps, not steps.
  assert.ok(!/Output|来源结果/.test(joined), joined);
  // The question is asked once, as the call, with the answer under it; the reply's markup never shows.
  assert.equal(page.filter(line => line.includes('酒店订单上的地址')).length, 1, joined);
  assert.ok(page.some(line => line.includes('✓ 在古城')), joined);
  assert.ok(!joined.includes('send_user_message_question_reply'), joined);
  assert.ok(!page.some(line => line.includes('你 ')), 'The reply is not an interjection');
});

test('scrolling under a pointer that stays put lights up no call: the pointer counts again once it moves', () => {
  const calls = Array.from({ length: 30 }, (_, i) => [call(`m${i}`, 'Bash', { command: `echo ${i}`, description: `Step number ${i}` }, 1 + i), result(`m${i}`, 1 + i)]).flat();
  const model = modelOf(parse([rec('user', '跑很多步', 0), said('开始。', 0), ...calls, said('好了。', 40, true), done(41, 41_000)]), { height: 12 });
  const gold = (state: AppState) => frame(state, model).some(line => spans(line).some(span => span.style?.fg === 'yellow' && span.text.trim()));
  let state = key(update(initialState(), model), keyOf('g'), model);
  const y = text(frame(state, model)).findIndex(line => line.includes('Step number 1')) + 1;
  state = key(state, { type: 'mouse', action: 'move', button: 35, x: 6, y }, model);
  assert.ok(gold(state), 'The call under the pointer lights up');
  const wheel = { type: 'mouse' as const, action: 'wheelDown' as const, button: 65, x: 6, y };
  state = key(state, wheel, model);
  assert.ok(state.scroll > 0);
  assert.ok(!gold(state), 'The page moved under the pointer: nothing lights up');
  assert.doesNotMatch(text(frame(state, model))[0], /⏎/);
  state = key(key(state, wheel, model), { type: 'mouse', action: 'move', button: 35, x: 6, y }, model);
  assert.ok(!gold(state), 'A report of the pointer where it already was is not a move');
  state = key(state, { type: 'mouse', action: 'move', button: 35, x: 7, y }, model);
  assert.ok(gold(state), 'Moved: the call under it lights up again');
});

test('a trackpad swipe with sideways steps among the downward ones only goes down, and stays put at the end', () => {
  const calls = Array.from({ length: 30 }, (_, i) => [call(`s${i}`, 'Bash', { command: `echo ${i}`, description: `Step number ${i}` }, 1 + i), result(`s${i}`, 1 + i)]).flat();
  const model = modelOf(parse([rec('user', '跑很多步', 0), ...calls, said('好了。', 40, true), done(41, 41_000)]), { height: 12 });
  // As recorded from a real swipe in kitty: down (65) and left (66), interleaved.
  const events = new InputParser().feed('\x1b[<65;1;1M\x1b[<66;1;1M'.repeat(40));
  let state = key(update(initialState(), model), keyOf('g'), model);
  const seen: number[] = [];
  for (const event of events) { state = key(state, event, model); seen.push(state.scroll); }
  assert.ok(seen.every((scroll, i) => i === 0 || scroll >= seen[i - 1]), 'Never back up');
  const end = seen.at(-1)!;
  assert.ok(end > 0);
  state = key(state, new InputParser().feed('\x1b[<66;1;1M')[0], model);
  assert.equal(state.scroll, end, 'At the end a sideways step moves nothing');
});

test('looking up a row\'s records in its own turn finds what a search of the whole session finds', () => {
  const session = parse([...FIRST, ...SECOND]);
  const rows = visibleTurnGroups(session).flatMap(group => turnView(group, false, 'claude').turn.segments.flatMap(segment => segment.kind === 'chapter' ? segment.chapter.rows : []));
  assert.ok(rows.length >= 5);
  for (const row of rows) assert.deepEqual(resolveOutlineEvidence(session, row.id, row.items[0]), resolveOutlineEvidence(session, row.id), row.label);
  // A hint from elsewhere still finds it.
  assert.deepEqual(resolveOutlineEvidence(session, rows[0].id, rows.at(-1)!.items[0]), resolveOutlineEvidence(session, rows[0].id));
});

test('a pointer that rests, or reaches the pane\'s edge on its way out, lets its call go dark', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]), { width: 48, height: 30 });
  const at = (x: number, y: number) => key(update(initialState(), model), { type: 'mouse', action: 'move', button: 35, x, y }, model);
  // Resting inside: a while; at an edge, at once.
  assert.equal(pointerRest(at(10, 10), model), 3000);
  assert.equal(pointerRest(at(48, 10), model), 150);
  assert.equal(pointerRest(at(10, 30), model), 150);
  assert.equal(pointerRest(update(initialState(), model), model), undefined);
  // Gone: no pointer, and a report of the same cell does not bring it back; a move does.
  const gone = pointerGone(at(10, 10));
  assert.equal(gone.pointer, undefined);
  assert.equal(key(gone, { type: 'mouse', action: 'move', button: 35, x: 10, y: 10 }, model).pointer, undefined);
  assert.deepEqual(key(gone, { type: 'mouse', action: 'move', button: 35, x: 11, y: 10 }, model).pointer, { x: 11, y: 10 });
});

test('a new turn while the reader is scrolled back in the newest one takes them there; on an older turn, a notice', () => {
  const two = modelOf(parse([...FIRST, ...SECOND, result('t5', 23), said('没有别的了。', 24, true), done(25, 5000)]), { now: Date.parse(at(30)) });
  const three = modelOf(parse([...FIRST, ...SECOND, result('t5', 23), said('没有别的了。', 24, true), done(25, 5000), rec('user', '提交吧', 40), said('好。', 41)]), { now: Date.parse(at(45)) });
  // On the newest turn, following paused by a scroll back.
  let state = update(initialState(), two);
  state = { ...state, follow: false };
  state = update(state, three);
  assert.deepEqual([state.index, state.follow, state.notice], [2, true, undefined]);
  // On an older turn: stays, with the notice.
  state = update({ ...update(initialState(), two), index: 0, follow: false }, three);
  assert.deepEqual([state.index, state.follow, state.notice], [0, false, 2]);
});

test('every call reads in grey under its tool\'s name; colour marks only a failure, a change\'s size, a call still out', () => {
  const commands = ['grep -rn "x" src | head -5', 'cat > notes.txt <<EOF\nhi\nEOF', 'npm test'];
  const session = parse([rec('user', '看看', 0), ...commands.flatMap((command, i) => [call(`c${i}`, 'Bash', { command, description: i === 2 ? 'Run the tests' : undefined }, 1 + i), result(`c${i}`, 1 + i, i === 2)]), said('好。', 20, true), done(21, 21_000)]);
  const body = turnBody(ctxOf(modelOf(session, { width: 80 }), 0));
  assert.ok(spans(body.find(line => plainText(line).trim() === 'Bash')!).some(span => span.text === 'Bash' && span.style?.bold && !span.style?.dim));
  const calls = body.filter(line => /^  [├└] /.test(plainText(line)));
  assert.equal(calls.length, 3);
  for (const line of calls) assert.ok(spans(line)[1].style?.dim, plainText(line));
  assert.ok(spans(calls[2]).some(span => span.style?.fg === 'red'), 'The failure is marked in red');
});

test('back from a detail a click opened, nothing stays selected; from one opened with ⏎, the call stays', () => {
  const model = modelOf(parse([...FIRST, ...SECOND]));
  let state = key(update(initialState(), model), keyOf('['), model);
  const y = text(frame(state, model)).findIndex(line => line.includes('Run the unit tests')) + 1;
  state = key(state, { type: 'mouse', action: 'press', button: 0, x: 6, y }, model);
  assert.equal(state.mode, 'detail');
  assert.equal(key(state, keyOf('escape'), model).call, undefined);
  const byKey = key(key(key(state, keyOf('escape'), model), keyOf('down'), model), keyOf('enter'), model);
  assert.equal(byKey.mode, 'detail');
  assert.equal(key(byKey, keyOf('escape'), model).call, 0);
});

test('a call that read an image opens it in the system viewer, the bytes of the time, not a page of its path', () => {
  // A real 1×1 PNG: the parser keeps only image bytes that are what they say.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const session = parse([
    rec('user', '看看截图', 0),
    call('i1', 'Read', { file_path: '/fixture/shot.png' }, 1),
    rec('user', [{ type: 'tool_result', tool_use_id: 'i1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }], 2),
    said('看到了。', 3, true), done(4, 4000),
  ]);
  const model = modelOf(session);
  let state = key(update(initialState(), model), keyOf('down'), model);
  assert.match(text(frame(state, model))[0], /⏎ 打开图片/);
  const opened = key(state, keyOf('enter'), model);
  assert.equal(opened.mode, 'turn');
  assert.deepEqual(opened.effect, { kind: 'view', image: { name: 'shot.png', data: png, mime: 'image/png', path: '/fixture/shot.png' } });
  // A click opens it too, and leaves nothing selected.
  const y = text(frame(state, model)).findIndex(line => line.includes('shot.png')) + 1;
  state = key(update(initialState(), model), { type: 'mouse', action: 'press', button: 0, x: 6, y }, model);
  assert.equal(state.effect?.kind, 'view');
  assert.equal(state.call, undefined);
});

test('a call that points somewhere opens that place; calls with a detail of their own keep it', () => {
  const session = parse([
    rec('user', '发布一下', 0),
    call('a1', 'Artifact', { file_path: '/fixture/page.html', url: 'https://claude.ai/artifact/abc' }, 1), result('a1', 2, false, 'Published at https://claude.ai/artifact/abc'),
    call('w1', 'WebFetch', { url: 'https://example.com/docs/page', prompt: 'read' }, 3), result('w1', 4),
    call('b1', 'Bash', { command: 'curl -s https://example.com/api', description: 'Fetch the API' }, 5), result('b1', 6),
    said('好了。', 7, true), done(8, 8000),
  ]);
  const model = modelOf(session);
  let state = key(update(initialState(), model), keyOf('down'), model);
  assert.match(text(frame(state, model))[0], /⏎ 打开链接/);
  assert.deepEqual(key(state, keyOf('enter'), model).effect, { kind: 'link', link: { target: 'https://claude.ai/artifact/abc', name: 'claude.ai' } });
  state = key(state, keyOf('down'), model);
  assert.deepEqual(key(state, keyOf('enter'), model).effect, { kind: 'link', link: { target: 'https://example.com/docs/page', name: 'example.com' } });
  // A command that mentions an address is still a command: its detail opens.
  state = key(state, keyOf('down'), model);
  assert.equal(key(state, keyOf('enter'), model).mode, 'detail');
});

test('a call that wraps lights up whole: golden and underlined on every line, nothing added at the end', () => {
  const session = parse([
    rec('user', '发布', 0),
    call('a1', 'Artifact', { url: 'https://claude.ai/artifact/KoZrtJW4XtTK2fMnYMvqiY/a/very/long/path/that/wraps' }, 1), result('a1', 2),
    said('好了。', 3, true), done(4, 4000),
  ]);
  const model = modelOf(session, { width: 40 });
  const state = key(update(initialState(), model), keyOf('down'), model);
  const screen = frame(state, model);
  const lit = screen.map(line => spans(line)).filter(parts => parts.some(span => span.style?.underline));
  assert.equal(lit.length, 2, 'Both lines of the address');
  for (const parts of lit) assert.ok(parts.filter(span => span.style?.underline).every(span => span.style?.fg === 'yellow'));
  assert.ok(!text(screen).slice(1).some(line => line.includes('⏎')));
});

test('a prompt reads as it was typed: no list indents; the folded answer runs its opening lines together into one full line', () => {
  const session = parse([
    rec('user', '1. 竖线要连起来，而且不要折叠，都展开 2. 方案选L1\n第二行', 0),
    said('核对过了：\n\n- 竖线连上了\n- 标签换了', 1, true), done(2, 2000),
  ]);
  const lines = text(turnBody(ctxOf(modelOf(session, { width: 40 }), 0))).map(line => line.trimEnd());
  // Each typed line beside the bar, its wrapped part too, none set in under a list number.
  const words = lines.slice(1, lines.indexOf('') > 0 ? lines.indexOf('') : undefined).filter(line => line.startsWith('┃ '));
  assert.ok(words.length >= 3);
  assert.ok(words.every(line => /^┃ \S/.test(line)), words.join('\n'));
  assert.equal(lines.at(-1), '  核对过了： 竖线连上了 标签换了 ▾');
});
