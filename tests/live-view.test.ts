import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LiveView } from '../packages/vscode/src/live-view';
import { renderSidecar, renderInlineEvidence, inlineRevision } from '../packages/vscode/src/render';
import { resolveOutlineEvidence } from '../packages/core/src/outline';
import type { SessionData, TimelineItem } from '../packages/core/src/model';

const health = { state: 'observing' as const, pendingBytes: 0, readBytes: 10 };
const narrative = (id: string, turnId: string, text = id): TimelineItem => ({ id, turnId, sessionId: 's', kind: 'message', title: '过程说明',
  summary: text, status: 'info', availability: 'available', sources: [{ file: '/fixture/s', line: 1 }],
  detail: { title: '过程说明', blocks: [{ kind: 'text', label: '正文', text }] } });
const input = (id: string): TimelineItem => ({ ...narrative(id, 't1'), kind: 'tool', title: 'Read', result: 'not-observed',
  detail: { title: 'Read', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ file_path: '/fixture/' + id }) }] } });
const session = (): SessionData => ({ id: 's', provider: 'codex', projectPath: '/fixture', title: 'Session', warnings: [], coverage: [],
  items: [narrative('old', 't1'), input('read-a'), input('read-b'), narrative('current', 't2')] });

async function fixture(t: { after(fn: () => void): void }, saved?: unknown) {
  const data = session(), view = new LiveView('project', data), messages: any[] = [];
  let state: any = saved;
  const dom = new JSDOM(renderSidecar({ projectName: 'project', session: data, streamId: view.streamId, nonce: 'fixture' }, view.current), { runScripts: 'outside-only' });
  t.after(async () => {
    // Let queued native <details> toggle events finish before jsdom tears down
    // document. Otherwise its pending listener reads an already closed window.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    dom.window.close();
  });
  const window = dom.window, document = window.document;
  // No jsdom layout claims: geometry in the anchor test is explicitly modeled.
  (window as any).acquireVsCodeApi = () => ({ getState: () => state, setState: (value: unknown) => { state = value; }, postMessage: (value: unknown) => messages.push(value) });
  window.eval(document.querySelector('script')!.textContent!);
  await new Promise<void>(resolve => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }) : resolve());
  const send = (value: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data: value }));
  send(view.update(data, health, true));
  return { data, view, dom, window, document, messages, send, get state() { return state; }, update() { const value = view.update(data, health); send(value); return value; } };
}

test('bridge versions changes, excludes untouched turns, and resets with the full public projection', () => {
  const data = session(), view = new LiveView('project', data);
  const first = view.update(data, health); assert.equal(first.baseVersion, 0); assert.equal(first.version, 1); assert.equal(first.turns.length, 0);
  data.items[0].detail!.blocks[0].text = '**late public text**';
  const late = view.update(data, health);
  assert.deepEqual(late.turns.map(turn => turn.key), ['turn:t1']); assert.ok(late.turns[0].html.includes('<strong>late public text</strong>'));
  assert.deepEqual(late.order, ['turn:t2', 'turn:t1']);
  const reset = view.update(data, health, true); assert.equal(reset.turns.length, 2); assert.equal(reset.reset, true);
  assert.ok(!('items' in reset)); assert.ok(!JSON.stringify(reset).includes('/fixture/read-a'));
});

test('DOM append keeps the unchanged turn, the focused row and its selection', async t => {
  const f = await fixture(t), { document } = f;
  const old = document.querySelector('[data-turn-panel="turn:t1"]')!;
  const row = document.querySelector<HTMLButtonElement>('[data-turn-panel="turn:t1"] .crow[data-item-id]')!;
  row.focus(); row.click();
  assert.equal(row.getAttribute('aria-pressed'), 'true');
  const opened = f.messages.filter(message => message.type === 'openDetail').length;
  f.data.items.push(narrative('new-turn', 't3'));
  const update = f.update(); assert.deepEqual(update.turns.map(turn => turn.key), ['turn:t3']);
  assert.equal(document.querySelector('[data-turn-panel="turn:t1"]'), old);
  assert.equal(document.querySelector('[data-turn-panel="turn:t1"] .crow[data-item-id]'), row, 'The same node, not a copy');
  assert.equal(document.activeElement, row); assert.equal(row.getAttribute('aria-pressed'), 'true');
  assert.deepEqual([...document.querySelectorAll<HTMLElement>('[data-turn-panel]')].map(panel => panel.dataset.turnPanel), ['turn:t3', 'turn:t2', 'turn:t1']);
  assert.equal(f.messages.filter(message => message.type === 'openDetail').length, opened, 'A live update never opens a detail');
});

test('same-turn changes morph the agent text in place while rows and delegated controls survive', async t => {
  const f = await fixture(t), { document } = f;
  const row = document.querySelector<HTMLButtonElement>('[data-turn-panel="turn:t1"] .crow[data-item-id]')!; row.focus();
  f.data.items[0].detail!.blocks[0].text = 'Now **updated**';
  f.update();
  assert.equal(document.querySelector('[data-turn-panel="turn:t1"] .crow[data-item-id]'), row); assert.equal(document.activeElement, row);
  assert.equal(document.querySelector('[data-text-id="old"] strong')?.textContent, 'updated');
  f.data.items.splice(3, 0, input('read-c'));
  f.update();
  // A delegated click on a row that arrived by live update still opens its detail.
  const fresh = [...document.querySelectorAll<HTMLButtonElement>('.crow[data-item-id]')].find(button => button.textContent!.includes('read-c'))!;
  fresh.click();
  assert.equal(f.messages.at(-1).type, 'openDetail');
  assert.equal(f.messages.at(-1).itemId, fresh.dataset.itemId);
});

test('missing versions request one resync; stale sessions and out-of-order messages never overwrite content', async t => {
  const f = await fixture(t);
  f.data.items.push(narrative('not-applied', 't3'));
  f.view.update(f.data, health); // dropped delivery
  const missed = f.view.update(f.data, health);
  const count = f.messages.length;
  f.send(missed); f.send(missed);
  assert.equal(f.messages.length, count + 1); assert.equal(f.messages.at(-1).type, 'observerReady');
  assert.equal(f.document.querySelector('[data-turn-panel="turn:t3"]'), null);
  f.send(f.view.update(f.data, health, true));
  assert.ok(f.document.querySelector('[data-turn-panel="turn:t3"]'));
  f.send({ ...missed, sessionId: 'claude:s', version: 100 });
  f.send({ ...missed, streamId: 'another-generation', version: 100 });
  f.send(missed);
  assert.ok(f.document.querySelector('[data-turn-panel="turn:t3"]'));
});

test('modeled block anchor offsets absorb a new turn above the reading viewport', async t => {
  const f = await fixture(t), timeline = f.document.querySelector<HTMLElement>('.timeline')!;
  timeline.scrollTop = 130;
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {} });
  timeline.getBoundingClientRect = () => rect(50, 500);
  // Synthetic positions depend on DOM membership and scroll offset, like a layout.
  for (const node of f.document.querySelectorAll<HTMLElement>('[data-observation-key], [data-turn-panel]')) {
    node.getBoundingClientRect = () => rect((f.document.querySelector('[data-turn-panel="turn:t3"]') ? 220 : 20) - timeline.scrollTop + 50, 180);
  }
  f.data.items.push(narrative('prepended', 't3')); f.update();
  assert.equal(timeline.scrollTop, 330, 'Compensates the modeled +200px above the anchor, not a real layout measurement');
});

test('paused observation preserves reading content and does not present an agent failure', async t => {
  const f = await fixture(t), panel = f.document.querySelector('[data-turn-panel="turn:t1"]');
  f.send(f.view.update(f.data, { ...health, state: 'paused', reason: 'source-changed' }));
  assert.match(f.document.querySelector('.observation-problem')!.textContent!, /来源发生替换或改写/);
  assert.equal(f.document.querySelector('[data-turn-panel="turn:t1"]'), panel);
  f.send({ type: 'workspaceChanged' }); assert.match(f.document.querySelector('.observation-problem')!.textContent!, /工作区已改变/);
});

test('patched Markdown remains inert for HTML, command links and remote images', async t => {
  const f = await fixture(t);
  f.data.items.push(narrative('unsafe', 't3', '<img src=x onerror="alert(1)"> [run](command:bad) ![remote](https://example.com/a.png)'));
  f.update();
  const turn = f.document.querySelector('[data-turn-panel="turn:t3"]')!;
  assert.equal(turn.querySelector('img, a, script, iframe'), null);
  assert.equal(turn.querySelector('[onerror]'), null);
  assert.ok(turn.textContent!.includes('remote'));
});

// Model layout explicitly: these assertions exercise scroll policy, not browser geometry.
function modelFollow(f: Awaited<ReturnType<typeof fixture>>) {
  const timeline = f.document.querySelector<HTMLElement>('.timeline')!;
  const ends: Record<string, number> = { 'turn:t2': 800, 'turn:t1': 3000 };
  Object.defineProperty(timeline, 'clientHeight', { value: 400 });
  Object.defineProperty(timeline, 'scrollHeight', { value: 3500 });
  f.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this === timeline ? 50 : this.classList.contains('turn-content-end')
      ? 50 + ends[this.closest<HTMLElement>('[data-turn-panel]')!.dataset.turnPanel!] - timeline.scrollTop : 0;
    return { top, bottom: top, height: 0, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {} };
  };
  const button = f.document.querySelector<HTMLButtonElement>('[data-follow-toggle]')!;
  return { timeline, ends, button };
}

test('live follow targets the newest turn tail for append, final answer and a new turn, never the bottom of history', async t => {
  const f = await fixture(t), { timeline, ends, button } = modelFollow(f);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  f.data.items.push(narrative('append', 't2')); ends['turn:t2'] = 900; f.update();
  assert.equal(timeline.scrollTop, 516);
  const answer = { ...narrative('final', 't2', 'The recorded final answer'), kind: 'answer' as const };
  f.data.items.push(answer); ends['turn:t2'] = 1000; f.update();
  assert.equal(timeline.scrollTop, 616);
  const turn = f.document.querySelector('[data-turn-panel="turn:t2"]')!;
  const order = [...turn.querySelectorAll('[data-observation-key]')].map(node => node.getAttribute('data-observation-key'));
  assert.ok(order.indexOf('answer:turn:t2') > order.indexOf('say:append'), 'The final answer remains after the actual steps');
  // A late historical result must not switch the reader to that old turn.
  f.data.items.push(narrative('late-old', 't1')); f.update();
  assert.equal(timeline.scrollTop, 616);
  f.data.items.push(narrative('new-turn', 't3')); ends['turn:t3'] = 220; f.update();
  assert.equal(timeline.scrollTop, 0);
});

test('a new turn resumes a paused follow: it jumps to the new turn, then follows its tail down', async t => {
  const f = await fixture(t), { timeline, ends, button } = modelFollow(f);
  timeline.scrollTop = 200;
  timeline.dispatchEvent(new f.window.Event('scroll'));
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  // More of the turn being read does not pull the reader away.
  f.data.items.push(narrative('append', 't2')); ends['turn:t2'] = 1000; f.update();
  assert.equal(timeline.scrollTop, 200);
  // A new turn does: top first, while it is short.
  f.data.items.push(narrative('new-turn', 't3')); ends['turn:t3'] = 220; f.update();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(timeline.scrollTop, 0);
  assert.equal(f.state.autoFollow, true);
  // Then down with it as it grows.
  f.data.items.push(narrative('more', 't3')); ends['turn:t3'] = 900; f.update();
  assert.equal(timeline.scrollTop, 516);
});

test('reader scrolling pauses follow across updates and refresh; explicit return resumes it', async t => {
  const f = await fixture(t), { timeline, ends, button } = modelFollow(f);
  timeline.scrollTop = 200;
  timeline.dispatchEvent(new f.window.Event('scroll'));
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  f.data.items.push(narrative('append', 't2')); ends['turn:t2'] = 1000; f.update();
  assert.equal(timeline.scrollTop, 200);
  const restored = await fixture(t, f.state);
  assert.equal(restored.document.querySelector('[data-follow-toggle]')!.getAttribute('aria-pressed'), 'false');
  button.click();
  assert.equal(timeline.scrollTop, 616);
  assert.equal(f.state.autoFollow, true);
  // Going to an older turn, from 目录 or with ‹, is deliberate history reading even before scrolling.
  f.document.querySelector<HTMLButtonElement>('.toc button[data-lens-turn-id="turn:t1"]')!.click();
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});


test('a burst is revealed one part at a time: the words, a beat, then each call; a later update does not cut it short', async t => {
  const f = await fixture(t), { document } = f;
  const now = new Date().toISOString();
  // The turn is running first; then a burst lands in it.
  f.data.items.find(item => item.id === 'current')!.timestamp = now; f.update();
  f.data.items.push(narrative('said-1', 't2', '先看解析器。'), narrative('said-2', 't2', '然后改视图。'), input('read-c'), input('read-d'));
  f.data.items.slice(-4).forEach(item => { item.turnId = 't2'; item.timestamp = now; });
  f.update();
  const panel = document.querySelector('[data-turn-panel="turn:t2"]')!;
  const arrived = ['say:said-1', 'say:said-2'].map(key => panel.querySelector<HTMLElement>(`[data-observation-key="${key}"]`)!)
    .concat([...panel.querySelectorAll<HTMLElement>('.crow-item')].slice(-2));
  assert.ok(arrived.every(node => node.classList.contains('arrived')));
  assert.deepEqual(arrived.map(node => node.matches('.csay') ? 'say' : 'row'), ['say', 'say', 'row', 'row'], 'The container does not fade as one block');
  const delays = arrived.map(node => parseInt(node.style.animationDelay, 10));
  assert.ok(delays.every((delay, index) => index === 0 || delay > delays[index - 1]), 'One after another');
  assert.ok(delays[2] - delays[1] > delays[3] - delays[2], 'Words get a longer beat than a call row');
  f.data.items.push(input('read-e')); Object.assign(f.data.items.at(-1)!, { turnId: 't2', timestamp: now });
  f.update();
  assert.ok(arrived.every(node => node.isConnected && node.classList.contains('arrived') && node.style.animationDelay), 'Still waiting or fading after the next morph');
  const later = panel.querySelector<HTMLElement>('.crow-item.arrived:last-child')!;
  assert.ok(parseInt(later.style.animationDelay, 10) > delays[3], 'A later burst queues behind the one still appearing');
  const tail = panel.querySelector<HTMLElement>('.live-tail')!;
  assert.ok(parseInt(tail.style.animationDelay, 10) > parseInt(later.style.animationDelay, 10), 'The loading line comes back last');
});

test('the newest open turn ends in a spinner while records come, says how long it has been quiet after a silence, and nothing for a stale turn', async t => {
  const f = await fixture(t), { document } = f;
  const panel = () => document.querySelector('[data-turn-panel="turn:t2"]')!;
  assert.ok(!panel().hasAttribute('data-fresh'), 'No timestamps: nothing is claimed');
  const current = f.data.items.find(item => item.id === 'current')!;
  current.timestamp = new Date(Date.now() - 5000).toISOString(); f.update();
  assert.ok(panel().hasAttribute('data-fresh') && !panel().hasAttribute('data-stale'));
  const tail = () => panel().querySelector('.live-tail')!;
  assert.ok(tail().querySelector('.cspin'), 'A spinner, as in the terminal');
  assert.equal(tail().textContent!.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿]/g, ''), '', 'No status word and no clock: the agent shows its own');
  current.timestamp = new Date(Date.now() - 20 * 60000).toISOString(); f.update();
  assert.ok(panel().hasAttribute('data-stale'));
  assert.equal(tail().textContent!.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿]/g, ''), '无新记录 · 20 分钟');
  current.timestamp = new Date(Date.now() - 2 * 86400000).toISOString(); f.update();
  assert.ok(!panel().hasAttribute('data-fresh'), 'A day-old open turn is not running');
});

test('scrolling back down to the newest turn\'s end resumes following; landing there without the reader does not', async t => {
  const f = await fixture(t, { sessionId: 'codex:s', autoFollow: false, readingVersion: 2 }), { document, window } = f;
  const timeline = document.querySelector<HTMLElement>('.timeline')!, button = document.querySelector('[data-follow-toggle]')!;
  const edge = document.querySelector('[data-turn-panel="turn:t2"] .turn-content-end')!;
  // Modeled geometry: the newest turn ends 400px into the scroll area.
  Object.defineProperties(timeline, { clientHeight: { value: 300, configurable: true }, scrollHeight: { value: 2000, configurable: true } });
  timeline.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  edge.getBoundingClientRect = () => ({ top: 400 - timeline.scrollTop } as DOMRect);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  timeline.scrollTop = 116; timeline.dispatchEvent(new window.Event('scroll'));
  assert.equal(button.getAttribute('aria-pressed'), 'false', 'An update or layout shift landing on the edge is not the reader');
  timeline.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40 }));
  timeline.scrollTop = 117; timeline.dispatchEvent(new window.Event('scroll'));
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  timeline.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -40 }));
  assert.equal(button.getAttribute('aria-pressed'), 'false', 'Moving up, away from the edge, pauses');
});

test('a fold the reader opens stays open across live updates and is kept in the saved state', async t => {
  const f = await fixture(t), { document, window } = f;
  f.data.items.splice(3, 0, { ...narrative('t1-answer', 't1', '结论。'), kind: 'answer' });
  f.update();
  const fold = () => document.querySelector<HTMLDetailsElement>('[data-turn-panel="turn:t1"] details[data-fold]')!;
  assert.ok(fold() && !fold().open, 'An earlier turn\'s answer folds to one line by default');
  fold().open = true; fold().dispatchEvent(new window.Event('toggle'));
  assert.equal(JSON.stringify(f.state.openFolds), JSON.stringify([fold().dataset.fold]));
  f.data.items.push(narrative('newer', 't3')); f.update();
  assert.ok(fold().open, 'A new turn does not close what the reader opened');
});

test('Claude Code\'s own idle or busy wins over the guess from silence', async t => {
  const f = await fixture(t), { document } = f;
  const panel = () => document.querySelector('[data-turn-panel="turn:t2"]')!;
  const current = f.data.items.find(item => item.id === 'current')!;
  current.timestamp = new Date(Date.now() - 5000).toISOString();
  f.send(f.view.update(f.data, { ...health, agent: 'idle' }));
  assert.ok(!panel().hasAttribute('data-fresh') && panel().hasAttribute('data-idle'));
  current.timestamp = new Date(Date.now() - 20 * 60000).toISOString();
  f.send(f.view.update(f.data, { ...health, agent: 'busy' }));
  assert.ok(panel().hasAttribute('data-fresh') && !panel().hasAttribute('data-stale') && !panel().hasAttribute('data-idle'));
});

test('when the followed turn ends, the page stays at its end, the answer folded there; following goes on', async t => {
  const f = await fixture(t, { sessionId: 'codex:s', autoFollow: true, readingVersion: 2 }), { document, window } = f;
  const timeline = document.querySelector<HTMLElement>('.timeline')!, button = document.querySelector('[data-follow-toggle]')!;
  const scrolls: unknown[] = []; (timeline as any).scrollTo = (options: unknown) => scrolls.push(options);
  f.data.items.find(item => item.id === 'current')!.timestamp = new Date().toISOString(); f.update();
  assert.ok(document.querySelector('[data-turn-panel="turn:t2"]')!.hasAttribute('data-last-at'));
  f.data.items.push({ ...narrative('answer', 't2', '最终的结论。'), kind: 'answer', title: '历史回答', timestamp: new Date().toISOString() });
  f.update();
  await new Promise(resolve => window.setTimeout(resolve, 1200));
  assert.ok(document.querySelector('[data-turn-panel="turn:t2"] details.fanswer:not([open])'), 'The answer, folded at the end');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'Still following: the end is where the answer is');
});
