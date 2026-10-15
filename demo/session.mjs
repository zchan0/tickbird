// The demo session in the README's pictures: made up, not recorded. Claude Code
// fixes a failing test in a small wc-like project, then adds a --json flag.
// Each step is what Claude Code writes to its transcript, and when, in
// milliseconds from the start; scripts/record-demo.mjs replays them.
//
// `screen` is what the agent's own pane shows for the step, for the left side
// of the picture: Claude Code draws each step whole when it comes.

export const PROJECT = '/Users/you/wordcount';
export const START = '2026-10-15T10:02:00';
export const PROMPT = 'One test is failing, fix it. Then add a --json flag that prints the counts as JSON, with a test.';

const COUNT_BEFORE = `// Counts lines, words and characters in a piece of text.
export function count(text) {
  const lines = text === '' ? 0 : text.split('\\n').length;
  const words = text.split(' ').filter(Boolean).length;
  const chars = [...text].length;
  return { lines, words, chars };
}`;
const BIN_BEFORE = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { count } from '../src/count.js';

const file = process.argv[2];
const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const { lines, words, chars } = count(text);
console.log(\`\${lines} \${words} \${chars}\${file ? ' ' + file : ''}\`);`;
const CLI_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('--json prints the counts as JSON', () => {
  const out = execFileSync('node', ['bin/wordcount.js', '--json'], { input: 'hello world' });
  assert.deepEqual(JSON.parse(out), { lines: 1, words: 2, chars: 11 });
});

test('without --json the counts stay on one line', () => {
  const out = execFileSync('node', ['bin/wordcount.js'], { input: 'hello world' });
  assert.equal(String(out).trim(), '1 2 11');
});`;
const numbered = text => text.split('\n').map((line, index) => `${String(index + 1).padStart(6)}→${line}`).join('\n');

const FAILED = `Error: Exit code 1
✖ words split on any whitespace, not only spaces (0.7ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    {
      lines: 2,
  +   words: 3,
  -   words: 4,
      chars: 19
    }
ℹ tests 3
ℹ pass 2
ℹ fail 1`;
const passed = count => `ℹ tests ${count}\nℹ pass ${count}\nℹ fail 0`;

/** Each step: when it is written, what it is, and how the agent's pane draws it. */
export const STEPS = [
  { at: 600, user: PROMPT },
  { at: 2000, say: 'I\'ll run the tests first to see which one fails.' },
  { at: 2500, call: 'b1', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
  { at: 3700, result: 'b1', error: true, content: FAILED, screen: ['Error: Exit code 1', '✖ words split on any whitespace, not only spaces'] },
  { at: 4300, say: 'The tab and newline case fails: `count()` splits words on spaces only. Let me look at it.' },
  { at: 4700, call: 'r1', tool: 'Read', input: { file_path: `${PROJECT}/src/count.js` } },
  { at: 4900, result: 'r1', content: numbered(COUNT_BEFORE), screen: ['Read 7 lines'] },
  { at: 5800, say: 'Splitting on any run of whitespace fixes it.' },
  { at: 6200, call: 'e1', tool: 'Edit', input: { file_path: `${PROJECT}/src/count.js`, old_string: "text.split(' ')", new_string: 'text.split(/\\s+/)' } },
  { at: 6500, result: 'e1', patch: { path: `${PROJECT}/src/count.js`, oldStart: 2, newStart: 2, lines: [
    '   export function count(text) {', "   const lines = text === '' ? 0 : text.split('\\n').length;",
    "-  const words = text.split(' ').filter(Boolean).length;", '+  const words = text.split(/\\s+/).filter(Boolean).length;', '   const chars = [...text].length;'] },
    screen: ['Updated src/count.js with 1 addition and 1 removal', '-  const words = text.split(\' \').filter(Boolean).length;', '+  const words = text.split(/\\s+/).filter(Boolean).length;'] },
  { at: 6900, call: 'b2', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests again' } },
  { at: 7900, result: 'b2', content: passed(3), screen: ['ℹ tests 3', 'ℹ pass 3'] },
  { at: 8500, say: 'All three pass. Now the `--json` flag: the command line reads its file argument here.' },
  { at: 8900, call: 'r2', tool: 'Read', input: { file_path: `${PROJECT}/bin/wordcount.js` } },
  { at: 9100, result: 'r2', content: numbered(BIN_BEFORE), screen: ['Read 8 lines'] },
  { at: 9800, call: 'e2', tool: 'Edit', input: { file_path: `${PROJECT}/bin/wordcount.js`, old_string: 'const file = process.argv[2];', new_string: "const args = process.argv.slice(2);\nconst json = args.includes('--json');\nconst file = args.find(arg => arg !== '--json');" } },
  { at: 10100, result: 'e2', patch: { path: `${PROJECT}/bin/wordcount.js`, oldStart: 4, newStart: 4, lines: [
    ' ', '-const file = process.argv[2];', '+const args = process.argv.slice(2);', "+const json = args.includes('--json');", "+const file = args.find(arg => arg !== '--json');",
    " const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');", '-const { lines, words, chars } = count(text);', '-console.log(`${lines} ${words} ${chars}${file ? \' \' + file : \'\'}`);',
    '+const counts = count(text);', '+if (json) console.log(JSON.stringify(counts));', "+else console.log(`${counts.lines} ${counts.words} ${counts.chars}${file ? ' ' + file : ''}`);"] },
    screen: ['Updated bin/wordcount.js with 6 additions and 3 removals'] },
  { at: 10600, call: 'w1', tool: 'Write', input: { file_path: `${PROJECT}/test/cli.test.js`, content: CLI_TEST } },
  { at: 10900, result: 'w1', created: `${PROJECT}/test/cli.test.js`, screen: ['Wrote 13 lines to test/cli.test.js'] },
  { at: 11300, call: 'b3', tool: 'Bash', input: { command: 'npm test', description: 'Run all the tests' } },
  { at: 12300, result: 'b3', content: passed(5), screen: ['ℹ tests 5', 'ℹ pass 5'] },
  { at: 13100, answer: 'Fixed the failing test and added `--json`.\n\n- `count()` splits words on any whitespace, so tabs and newlines separate words too.\n- `wordcount --json file.txt` prints `{"lines":1,"words":2,"chars":11}`; without the flag the output is as before.\n- New tests in `test/cli.test.js`. All 5 pass.' },
  { at: 13300, done: 13300 },
];

/** The Claude Code transcript as written by `at` ms. */
export function transcript(at) {
  const base = Date.parse(START);
  const time = ms => new Date(base + ms).toISOString();
  const calls = new Map(STEPS.filter(step => step.call).map(step => [step.call, step]));
  let uuid = 0;
  const record = (type, content, ms, extra = {}) => ({ type, uuid: `demo-${++uuid}`, timestamp: time(ms), sessionId: 'demo', cwd: PROJECT, message: { role: type, content }, ...extra });
  return STEPS.filter(step => step.at <= at).map(step => {
    if (step.user) return record('user', step.user, step.at);
    if (step.say) return record('assistant', [{ type: 'text', text: step.say }], step.at);
    if (step.answer) return { ...record('assistant', [{ type: 'text', text: step.answer }], step.at), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: step.answer }] } };
    if (step.call) return record('assistant', [{ type: 'tool_use', id: step.call, name: step.tool, input: step.input }], step.at);
    if (step.done) return { type: 'system', subtype: 'turn_duration', durationMs: step.done, uuid: `demo-${++uuid}`, timestamp: time(step.at), sessionId: 'demo' };
    const call = calls.get(step.result);
    if (step.patch) {
      const { path, oldStart, newStart, lines } = step.patch;
      const hunk = { oldStart, oldLines: lines.filter(line => !line.startsWith('+')).length, newStart, newLines: lines.filter(line => !line.startsWith('-')).length, lines };
      return { ...record('user', [{ type: 'tool_result', tool_use_id: step.result, content: `The file ${path} has been updated.` }], step.at), toolUseResult: { filePath: path, structuredPatch: [hunk] } };
    }
    if (step.created) return { ...record('user', [{ type: 'tool_result', tool_use_id: step.result, content: `File created successfully at: ${step.created}` }], step.at), toolUseResult: { type: 'create', filePath: step.created, structuredPatch: [] } };
    const content = step.content ?? 'ok';
    return { ...record('user', [{ type: 'tool_result', tool_use_id: step.result, is_error: Boolean(step.error), content }], step.at),
      toolUseResult: step.error ? content : call?.tool === 'Bash' ? { stdout: content, stderr: '', interrupted: false } : undefined };
  });
}
