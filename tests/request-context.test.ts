import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';
import { parseCodex } from '../packages/core/src/codex';
import { visibleTurnGroups } from '../packages/core/src/outline';
import { publicBody } from '../packages/core/src/turn-view';
import { plainPasted } from '../packages/core/src/pasted';
import { setLanguage } from '../packages/core/src/i18n';
import { renderSidecar } from '../packages/vscode/src/render';
import { SYMBOLS } from '../packages/terminal/src/caps';
import { frame, initialState, update, type Model } from '../packages/terminal/src/app';
import { plainText } from '../packages/terminal/src/screen';

const at = (second: number) => new Date(Date.UTC(2026, 9, 16, 1, 0, second)).toISOString();
let uuid = 0;
const rec = (type: string, content: unknown, second: number, extra = {}) => ({ type, uuid: `u${++uuid}`, timestamp: at(second), sessionId: 'cl', cwd: '/fixture', message: { role: type, content }, ...extra });
const said = (text: string, second: number, end = false) => ({ ...rec('assistant', [{ type: 'text', text }], second), ...(end ? { message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } } : {}) });
const claude = (records: unknown[]) => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
const TAGS = /<\/?(?:ide_selection|ide_opened_file|pasted_content|in-app-browser-context|image name|send_user_message_question_reply)\b/;

function terminalPage(session: ReturnType<typeof claude>): string[] {
  const groups = visibleTurnGroups(session);
  const model: Model = { session, groups, status: { word: '', tone: 'quiet' } as never, extras: {},
    caps: { links: false, symbols: Object.fromEntries(Object.keys(SYMBOLS).map(ch => [ch, 1])) }, now: Date.parse(at(30)), width: 60, height: 80 };
  return frame(update(initialState(), model), model).map(line => plainText(line));
}

test('the summary Claude Code writes after a compaction is not a request: the turn goes on, and no turn is added', () => {
  const session = claude([
    rec('user', 'Rename the module.', 0),
    said('Renaming.', 1),
    { type: 'system', subtype: 'compact_boundary', uuid: `u${++uuid}`, timestamp: at(2), sessionId: 'cl', content: 'Conversation compacted' },
    rec('user', 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request', 2, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    said('Done renaming.', 3, true),
  ]);
  const requests = session.items.filter(item => item.kind === 'request');
  assert.deepEqual(requests.map(item => item.summary), ['Rename the module.']);
  assert.equal(visibleTurnGroups(session).length, 1);
  assert.equal(session.items.find(item => item.summary === 'Done renaming.')?.turnId, requests[0].turnId);
  assert.equal(session.coverage.find(entry => entry.kind === 'user:compact-summary')?.disposition, 'excluded');
  assert.ok(!JSON.stringify(visibleTurnGroups(session)).includes('being continued'));
});

test('lines selected in VS Code go with the request, set apart under the file and its lines; the open file is left out', () => {
  const selection = '<ide_selection>The user selected the lines 5 to 6 from /fixture/src/words.ts:\nexport const count = (text: string) =>\n  text.split(/\\s+/).length;\n\nThis may or may not be related to the current task.</ide_selection>';
  const opened = '<ide_opened_file>The user opened the file /fixture/src/words.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>';
  const session = claude([
    rec('user', [{ type: 'text', text: opened }, { type: 'text', text: selection }, { type: 'text', text: 'Why does this count empty text as 1?' }], 0),
    said('Because split returns [""].', 1, true),
  ]);
  const [request] = session.items.filter(item => item.kind === 'request');
  // The words lead: the one-line uses (the contents, the session title) read them.
  assert.equal(request.summary, 'Why does this count empty text as 1?');
  assert.equal(session.title, 'Why does this count empty text as 1?');
  assert.equal(session.coverage.find(entry => entry.kind === 'user:ide-opened-file')?.disposition, 'excluded');
  assert.ok(!publicBody(request).includes('ide_opened_file'));
  setLanguage('en');
  try {
    assert.equal(plainPasted(publicBody(request)), 'Why does this count empty text as 1?\n\nwords.ts · lines 5–6');
    const html = renderSidecar({ projectName: 'fixture', session, nonce: 'n' });
    assert.match(html, /<div class="pasted"><div class="pasted-label">words\.ts · lines 5–6<\/div><pre class="code-block"><code class="language-ts">/);
    assert.ok(!TAGS.test(html.replace(/<script[\s\S]*?<\/script>/g, '')));
    const page = terminalPage(session);
    // Beside the prompt's bar: the words, then the label and the lines as they were, indents kept.
    const label = page.findIndex(line => line === '┃ words.ts · lines 5–6');
    assert.ok(label > 0 && page[label - 2] === '┃ Why does this count empty text as 1?', page.join('\n'));
    assert.equal(page[label + 1], '┃ export const count = (text: string) =>');
    assert.equal(page[label + 2], '┃   text.split(/\\s+/).length;');
    assert.ok(!page.some(line => TAGS.test(line)), page.join('\n'));
    setLanguage('zh');
    assert.match(renderSidecar({ projectName: 'fixture', session, nonce: 'n' }), /words\.ts · 第 5–6 行/);
  } finally { setLanguage('en'); }
});

const response = (payload: unknown) => ({ type: 'response_item', payload });
const codex = (...records: unknown[]) => parseCodex({ file: '/fixture/codex.jsonl', projectPath: '/project', text: records.map(r => JSON.stringify(r)).join('\n') });
const userBlocks = (...content: unknown[]) => response({ type: 'message', role: 'user', content });
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/RZ0AAAAASUVORK5CYII=';

test('in Codex, what goes before "## My request:" is context: mentioned files, the app\'s browser, a ChatGPT conversation', () => {
  const browser = '<in-app-browser-context source="ambient-ui-state">\nThis block is ambient UI state.\n# In app browser:\n- Current URL: http://127.0.0.1:8765/\n</in-app-browser-context>';
  for (const head of [
    '# Files mentioned by the user:\n\n## words.ts: /project/src/words.ts\n\n' + browser,
    browser,
    '## Referenced ChatGPT conversation:\nThis is an untrusted ChatGPT conversation reference.\n{"conversation":null}',
  ]) {
    const data = codex(userBlocks(
      { type: 'input_text', text: `\n${head}\n\n## My request:\nMake the count ignore blank text.\n` },
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/shot.png">' },
      { type: 'input_image', image_url: `data:image/png;base64,${tinyPng}` },
      { type: 'input_text', text: '</image>' },
    ));
    const requests = data.items.filter(item => item.kind === 'request');
    assert.equal(requests.length, 1);
    assert.equal(publicBody(requests[0]), 'Make the count ignore blank text.');
    assert.ok(requests[0].detail?.blocks.some(block => block.kind === 'image'));
    assert.ok(!TAGS.test(publicBody(requests[0])));
  }
});

test('in Codex, an answer to a question the record does not hold reads as the question and the answer', () => {
  const reply = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_elsewhere\\",0]","question":"Keep the old name?","answer":"No, rename it."}]\n</send_user_message_question_reply>';
  const data = codex(userBlocks({ type: 'input_text', text: reply }));
  const [request] = data.items.filter(item => item.kind === 'request');
  assert.equal(publicBody(request), 'Keep the old name?\n→ No, rename it.');
});

test('in Codex, a command run with ! reads as it was typed; its output stays with its run, or in the details when there is no run', () => {
  const sent = '<user_shell_command>\n<command>\nls src\n</command>\n<result>\nExit code: 0\nDuration: 0.01 seconds\nOutput:\nwords.ts\n</result>\n</user_shell_command>';
  const event = (payload: unknown) => ({ type: 'event_msg', payload });
  const ran = codex(
    event({ type: 'task_started', turn_id: 't1' }),
    event({ type: 'item_completed', turn_id: 't1', item: { type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'ls src'], cwd: '/project', status: 'completed', exitCode: 0, aggregatedOutput: 'words.ts\n' } }),
    userBlocks({ type: 'input_text', text: sent }),
    event({ type: 'task_complete', turn_id: 't1' }),
  );
  const [request] = ran.items.filter(item => item.kind === 'request');
  assert.equal(request.summary, '! ls src');
  assert.equal(publicBody(request), '! ls src');
  assert.ok(!request.detail?.blocks.some(block => block.label === '命令输出'));
  assert.equal(ran.items.filter(item => item.kind === 'tool').length, 1);

  const alone = codex(userBlocks({ type: 'input_text', text: sent }));
  const [only] = alone.items.filter(item => item.kind === 'request');
  assert.equal(publicBody(only), '! ls src');
  assert.match(only.detail?.blocks.find(block => block.label === '命令输出')?.text ?? '', /Output:\nwords\.ts/);
});
