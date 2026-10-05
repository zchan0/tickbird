import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from '../packages/core/src/claude';
import { projectSidecar, renderSidecar } from '../packages/vscode/src/render';

const parse = (records: unknown[]) => parseClaude({ file: '/fixture/cl.jsonl', projectPath: '/fixture', text: records.map(r => JSON.stringify(r)).join('\n') + '\n' });
const at = (second: number) => new Date(Date.UTC(2026, 9, 5, 1, 0, second)).toISOString();
let uuid = 0;
const row = (type: string, content: unknown, second: number) => ({ type, uuid: `u${++uuid}`, timestamp: at(second), sessionId: 'cl', cwd: '/fixture', message: { role: type, content } });
// The newest turn is still running: a call is out and no answer has come.
const session = () => parse([
  row('user', '写一个文件', 0),
  row('assistant', [{ type: 'text', text: '我来创建 numbers.txt。' }], 1),
  row('assistant', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/p/numbers.txt', content: '1\n2\n' } }], 2),
]);
const latestHtml = (live?: Parameters<typeof projectSidecar>[0]['live']) => projectSidecar({ projectName: 'p', session: session(), locale: 'zh-CN', live }).turns.at(-1)!.html;

test('waiting for an approval replaces the status word, naming the tool and the file', () => {
  const html = latestHtml({ approval: { tool: 'Write', summary: '/private/tmp/project/numbers.txt' } });
  assert.match(html, /class="cseg live-tail awaiting"/);
  assert.match(html, /<span class="cwait">等你批准<\/span> · <span class="cwait-what">Write numbers\.txt<\/span>/);
  assert.ok(!html.includes('data-live-verb'), 'No status word while the agent waits for the reader');
  assert.match(latestHtml({ approval: { tool: 'Bash', summary: 'rm -rf build' } }), /Bash rm -rf build/);
  assert.match(latestHtml({}), /data-live-verb/, 'Without an approval the status word stays');
});

test('text on screen shows faint before the tail, and its markup is escaped like any agent text', () => {
  const html = latestHtml({ draft: '**先说结论**：<img src=x onerror=alert(1)>' });
  const draft = html.indexOf('class="cseg cdraft-item"'), tail = html.indexOf('class="cseg live-tail"');
  assert.ok(draft > 0 && tail > draft, 'The draft comes before the status line');
  assert.match(html, /<strong>先说结论<\/strong>/);
  assert.ok(!/<img/.test(html.slice(draft, tail)));
});

test('extras belong to the newest turn only and change its HTML without a new record', () => {
  const plain = projectSidecar({ projectName: 'p', session: session(), locale: 'zh-CN' });
  const waiting = projectSidecar({ projectName: 'p', session: session(), locale: 'zh-CN', live: { approval: { tool: 'Write', summary: 'numbers.txt' } } });
  assert.notEqual(plain.turns.at(-1)!.html, waiting.turns.at(-1)!.html);
  const ended = parse([row('user', '只回复 ok', 0), { ...row('assistant', [], 1), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }]);
  const html = projectSidecar({ projectName: 'p', session: ended, locale: 'zh-CN', live: { approval: { tool: 'Write', summary: 'x' }, draft: 'late' } }).turns.at(-1)!.html;
  assert.ok(!html.includes('等你批准') && !html.includes('cdraft'), 'An ended turn waits for nothing');
});

test('the follow button and the integration hint render hidden unless asked for', () => {
  const page = (options: { followPaused?: boolean; integrationHint?: boolean }) => renderSidecar({ projectName: 'p', session: session(), nonce: 'n', streamId: 's', ...options });
  const panel = (html: string) => html.slice(html.indexOf('<main'));
  assert.match(panel(page({})), /class="follow-button follow-session" data-action="resumeFollow"[^>]* hidden>/);
  assert.match(panel(page({})), /<div class="integration-hint" hidden>/);
  assert.doesNotMatch(panel(page({ followPaused: true })), /data-action="resumeFollow"[^>]* hidden>/);
  assert.match(panel(page({ integrationHint: true })), /<div class="integration-hint"><span>装上 Agent Sidecar 接入后/);
});

test('the page shows and hides the follow button and the hint as the host says, and posts the reader’s choices', async t => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(renderSidecar({ projectName: 'p', session: session(), nonce: 'n', streamId: 's' }), { runScripts: 'outside-only' });
  t.after(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); dom.window.close(); });
  const { window } = dom, { document } = window;
  const sent: unknown[] = [];
  (window as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => undefined, postMessage: (value: unknown) => sent.push(value) });
  window.eval(document.querySelector('script')!.textContent!);
  const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const button = document.querySelector<HTMLButtonElement>('.follow-session')!, hint = document.querySelector<HTMLElement>('.integration-hint')!;
  assert.equal(button.hidden, true); assert.equal(hint.hidden, true);
  send({ type: 'follow', paused: true }); send({ type: 'integrationHint', show: true });
  assert.equal(button.hidden, false); assert.equal(hint.hidden, false);
  button.click();
  hint.querySelector<HTMLButtonElement>('[data-action="dismissHint"]')!.click();
  // Objects from the page's realm compare by their JSON.
  assert.equal(JSON.stringify(sent.filter((message: any) => message.type !== 'observerReady')), JSON.stringify([{ type: 'resumeFollow' }, { type: 'dismissHint' }]));
  send({ type: 'follow', paused: false }); send({ type: 'integrationHint', show: false });
  assert.equal(button.hidden, true); assert.equal(hint.hidden, true);
});
