import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, SessionData, TimelineItem } from '../packages/core/src/model';
import { actionRows, actionRowSections, outlineTurn, resolveOutlineEvidence, visibleTurnGroups } from '../packages/core/src/outline';
import { groupSessionTurns } from '../packages/core/src/timeline';
import { parseCodex } from '../packages/core/src/codex';
import { renderDetail, renderInlineEvidence, renderSidecar } from '../packages/vscode/src/render';

const nonce = 'renderer-test-nonce';
function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: 'tool-1', sessionId: 'session-1', turnId: 'turn-1', kind: 'tool', title: '运行测试',
    summary: '读取一条测试结果', status: 'completed', availability: 'available',
    sources: [{ file: '/project/session.jsonl', line: 12, recordId: 'record-1', block: 0 }],
    detail: { title: '测试输出', blocks: [{ kind: 'code', label: '返回内容', text: 'PASS example.test.ts' }] },
    ...overrides,
  };
}
function session(items: TimelineItem[]): SessionData {
  return { id: 'session-1', provider: 'codex', projectPath: '/project', title: '核对预览行为', items, coverage: [], warnings: [] };
}

function projectedRows(data: SessionData) {
  return visibleTurnGroups(data).flatMap(turn => outlineTurn(turn).nodes.flatMap(node => node.kind === 'actions' ? actionRowSections(node).flatMap(section => section.rows) : []));
}
function legacyRows(data: SessionData) {
  return groupSessionTurns(data).flatMap(turn => outlineTurn(turn).nodes.flatMap(node => node.kind === 'actions' ? actionRows(node) : []));
}
function readInput(id: string, overrides: Partial<TimelineItem> = {}): TimelineItem {
  return item({ id, title: 'Read', result: 'not-observed', summary: '记录中的读取输入', detail: {
    title: '读取输入', blocks: [{ kind: 'json', label: '记录中的调用参数', text: JSON.stringify({ file_path: `/project/${id}.ts` }) }],
  }, ...overrides });
}
/** Chapter rows: a button when the record is readable, a group otherwise. */
function actionHtmlRows(html: string): string[] {
  return [...html.matchAll(/<(button|div)\b(?=[^>]*\bclass="crow(?:\s[^"]*)?")[^>]*>[\s\S]*?<\/\1>/g)].map(match => match[0]);
}
const attributeValue = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function detailRegions(html: string) {
  const main = html.match(/<main class="detail"[^>]*>([\s\S]*?)<\/main>/)?.[1];
  assert.ok(main);
  // Locate disclosures by their source list, not by presentation color or the
  // exact summary wording. Question raw-structure disclosures are independent.
  const sources = [...main.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)]
    .map(match => match[0]).filter(disclosure => disclosure.includes('class="source-list"'));
  return { main, sources, primary: sources.reduce((content, disclosure) => content.replace(disclosure, ''), main) };
}

function decodeHtmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]!));
}

// Execute the emitted script against a small DOM fixture. This does not claim real-host DOM behavior.
function scriptFixture(options: { detail?: boolean; state?: Record<string, unknown>; focused?: boolean; provider?: Provider; sessionId?: string; nodeId?: string; turnCount?: number; hiddenTurns?: number[]; foldActions?: boolean; actionFoldId?: string; viewport?: { width: number; height: number }; geometry?: { viewportHeight: number; panelHeights: number[] } } = {}) {
  const handlers = new Map<string, (event: any) => void>();
  const sidecarHandlers = new Map<string, (event: any) => void>();
  const windowHandlers = new Map<string, (event: any) => void>();
  const sent: unknown[] = [];
  const focused: Array<{ dataset: Record<string, string>; preventScroll?: boolean }> = [];
  let saved = options.state;
  class FixtureElement {
    disabled = false;
    open = false;
    hidden = false;
    offsetTop = 0;
    offsetHeight = 16;
    offsetWidth = 18;
    surface = '';
    style = { left: '', top: '' };
    rect?: { right: number; top: number; height: number };
    listeners = new Map<string, () => void>();
    attributes = new Map<string, string>();
    textContent = '';
    parent?: FixtureElement;
    get parentElement(): FixtureElement | null { return this.parent ?? null; }
    constructor(public dataset: Record<string, string> = {}, public tagName = 'BUTTON') {}
    closest(selector: string): FixtureElement | null {
      if (selector.split(',').some(part => this.matches(part.trim()))) return this;
      return this.parent?.closest(selector) ?? null;
    }
    matches(selector: string) {
      return selector === 'button' ? this.tagName === 'BUTTON'
        : selector === '[hidden]' ? this.hidden
        : selector === 'details:not([open])' ? this.tagName === 'DETAILS' && !this.open
        : selector === 'summary' ? this.tagName === 'SUMMARY'
        : selector === 'summary[data-action-group]' ? this.tagName === 'SUMMARY' && Boolean(this.dataset.actionGroup)
        : selector === 'button[data-turn-id]' ? this.tagName === 'BUTTON' && Boolean(this.dataset.turnId)
        : selector === '.turn-map' ? this.surface === 'turn-map'
        : selector === '.turn-lens' ? this.surface === 'turn-lens'
        : selector === '.turn-panel' || selector === '[data-turn-panel]' || selector === 'section[data-turn-panel]'
          ? Boolean(this.dataset.turnPanel) : false;
    }
    addEventListener(type: string, handler: () => void) { this.listeners.set(type, handler); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    toggleAttribute(name: string, force?: boolean) { const on = force ?? !this.attributes.has(name); if (on) this.attributes.set(name, ''); else this.attributes.delete(name); return on; }
    querySelector(selector: string) { return selector === 'summary' ? summaries.find(summary => summary.parent === this) ?? null : null; }
    getBoundingClientRect() { return this.rect ?? { right: 19, top: 49 + this.offsetTop - turnMap.scrollTop, height: this.offsetHeight }; }
    focus(value: { preventScroll?: boolean }) {
      focused.push({ dataset: { ...this.dataset }, ...value });
      if (!options.detail) sidecarHandlers.get('focusin')?.({ target: this });
    }
  }
  const node = new FixtureElement({ itemId: options.nodeId ?? 'tool-1' });
  const earlierNode = new FixtureElement({ itemId: 'tool-previous' });
  const contextNode = new FixtureElement({ itemId: 'context-1' });
  const turnCount = options.turnCount ?? 2;
  const nav = Array.from({ length: turnCount }, (_, index) => turnCount - index).filter(number => !options.hiddenTurns?.includes(number)).map((number, index) => {
    const button = new FixtureElement({ turnId: `turn:turn-${number}` });
    button.offsetTop = 8 + index * 16;
    return button;
  });
  const panels = nav.map(button => new FixtureElement({ turnPanel: button.dataset.turnId }, 'SECTION'));
  panels.forEach((panel, index) => { panel.offsetTop = 14 + index * 1000; });
  nav.forEach((button, index) => button.setAttribute('aria-pressed', String(index === 0)));
  const backgrounds = [new FixtureElement({ actionGroup: 'background:turn:turn-1' }, 'DETAILS'), new FixtureElement({ actionGroup: `background:turn:turn-${turnCount}` }, 'DETAILS')];
  const summaries = backgrounds.map(group => new FixtureElement({ actionGroup: group.dataset.actionGroup }, 'SUMMARY'));
  backgrounds.forEach((group, index) => { group.parent = index ? panels[0] : panels.at(-1); summaries[index].parent = group; });
  node.parent = panels[0];
  earlierNode.parent = panels.at(-1);
  contextNode.parent = backgrounds[1];
  const actionFolds = options.foldActions ? [new FixtureElement({ actionGroup: options.actionFoldId ?? 'action-section:fixture-inputs' }, 'DETAILS')] : [];
  const actionSummaries = actionFolds.map(group => new FixtureElement({ actionGroup: group.dataset.actionGroup }, 'SUMMARY'));
  actionFolds.forEach((group, index) => { group.parent = panels[0]; actionSummaries[index].parent = group; node.parent = group; });
  const refresh = new FixtureElement({ action: 'refresh' });
  const keep = new FixtureElement({ action: 'keep' });
  const status = new FixtureElement();
  status.textContent = '临时预览';
  keep.textContent = '保留此页';
  const controls = [refresh, new FixtureElement({ action: 'coverage' }), new FixtureElement({ action: 'chooseSession' })];
  const timelineHandlers = new Map<string, () => void>();
  let timelineScrollTop = 137;
  const timeline = {
    clientHeight: options.geometry?.viewportHeight ?? 300,
    get scrollHeight() { return options.geometry ? (panels.at(-1)?.offsetTop ?? 0) + (panels.at(-1)?.offsetHeight ?? 0) + 20 : Number.POSITIVE_INFINITY; },
    get scrollTop() { return timelineScrollTop; },
    set scrollTop(value: number) {
      timelineScrollTop = options.geometry ? Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight))) : value;
    },
    addEventListener: (type: string, listener: () => void) => timelineHandlers.set(type, listener),
  };
  const mapHandlers = new Map<string, () => void>();
  const turnMap = Object.assign(new FixtureElement({}, 'NAV'), { scrollTop: 0, clientHeight: 300, surface: 'turn-map',
    addEventListener: (type: string, listener: () => void) => { mapHandlers.set(type, listener); } });
  nav.forEach(button => { button.parent = turnMap; });
  const turnLens = new FixtureElement({}, 'NAV');
  turnLens.surface = 'turn-lens';
  turnLens.hidden = true;
  turnLens.offsetWidth = Math.min(260, (options.viewport?.width ?? 300) - 28);
  const lensNav = nav.map(button => {
    const entry = new FixtureElement({ lensTurnId: button.dataset.turnId });
    entry.parent = turnLens;
    return entry;
  });
  Object.defineProperty(turnLens, 'offsetHeight', { get: () => Math.min(12 + lensNav.filter(button => !button.hidden).length * 40, (options.viewport?.height ?? 700) - 16) });
  const sidecar = {
    addEventListener: (type: string, listener: (event: any) => void) => sidecarHandlers.set(type, listener),
    querySelectorAll: () => controls,
  };
  const document = {
    body: { dataset: { sessionId: 'session-1' } }, readyState: 'complete', scrollingElement: { scrollTop: 880 },
    hasFocus: () => options.focused ?? true,
    addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener),
    querySelectorAll: (selector: string) => {
      if (options.detail || selector === '[data-text-id]' || selector === '[data-inline-id]' || selector === 'details[data-fold]') return [];
      if (selector === 'button[data-item-id]') return [earlierNode, node, contextNode];
      if (selector === 'button[data-turn-id]') return nav;
      if (selector === 'button[data-lens-turn-id]' || selector === '.toc button[data-lens-turn-id]') return lensNav;
      if (selector === '[data-turn-total]' || selector === '.cspin' || selector.startsWith('[data-nav=')) return [];
      if (selector === '[data-turn-panel]' || selector === '.turn-panel[data-turn-panel]' || selector === 'section[data-turn-panel]') return panels;
      if (selector === 'details[data-action-group]') return [...backgrounds, ...actionFolds];
      if (selector === 'summary[data-action-group]') return [...summaries, ...actionSummaries];
      throw new Error(`Unsupported fixture selector: ${selector}`);
    },
    querySelector: (selector: string) => {
      if (selector === '.sidecar') return options.detail ? null : sidecar;
      if (selector === '.timeline') return options.detail ? null : timeline;
      if (selector === '.turn-map') return options.detail ? null : turnMap;
      if (selector === '.turn-lens') return options.detail ? null : turnLens;
      if (selector === '.detail button[data-action="keep"]') return options.detail ? keep : null;
      if (selector === '[data-keep-status]') return options.detail ? status : null;
      return null;
    },
  };
  const fixtureSession = { ...session(Array.from({ length: turnCount }, (_, index) => item({
    id: index === turnCount - 1 ? 'tool-1' : index === 0 ? 'tool-previous' : `tool-${index + 1}`,
    turnId: `turn-${index + 1}`,
    ...(options.hiddenTurns?.includes(index + 1) ? { kind: 'notice', title: '回合结束', summary: '', status: 'completed', availability: 'none', detail: undefined } : {}),
  }))),
    id: options.sessionId ?? 'session-1', provider: options.provider ?? 'codex' };
  fixtureSession.items = fixtureSession.items.map(entry => ({ ...entry, sessionId: fixtureSession.id }));
  const html = options.detail ? renderDetail({ item: item(), provider: 'codex', kept: false, nonce })
    : renderSidecar({ projectName: 'project', session: fixtureSession, nonce });
  document.body.dataset.sessionId = html.match(/data-session-id="([^"]*)"/)![1];
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);
  if (options.geometry) {
    // Geometry fixture models browser scroll clamping and the emitted final-only
    // minimum. It does not claim to replace a browser layout/offset measurement.
    const finalMinimum = /\.turn-panel:last-child\s*\{[^}]*min-height:\s*100%/.test(html)
      ? Math.max(0, options.geometry.viewportHeight - 14 - 20) : 0;
    let top = 14;
    panels.forEach((panel, index) => {
      panel.offsetTop = top;
      panel.offsetHeight = Math.max(options.geometry!.panelHeights[index] ?? 0, index === panels.length - 1 ? finalMinimum : 0);
      top += panel.offsetHeight + 28;
    });
  }
  runInNewContext(source, {
    Element: FixtureElement, document, setInterval: () => 0,
    window: { innerWidth: options.viewport?.width ?? 300, innerHeight: options.viewport?.height ?? 700, addEventListener: (type: string, listener: (event: any) => void) => windowHandlers.set(type, listener) },
    acquireVsCodeApi: () => ({ getState: () => saved,
      setState: (value: Record<string, unknown>) => { saved = JSON.parse(JSON.stringify(value)); },
      postMessage: (value: unknown) => sent.push(JSON.parse(JSON.stringify(value))),
    }),
  });
  return { node, earlierNode, contextNode, refresh, keep, status, sent, focused, timeline, turnMap, turnLens, lensNav, document, windowHandlers, backgrounds, summaries, actionFolds, actionSummaries, nav, panels,
    get state() { return saved; },
    click: (target: FixtureElement) => handlers.get('click')!({ target }),
    focus: (target: FixtureElement) => sidecarHandlers.get('focusin')!({ target }),
    blur: (target: FixtureElement, relatedTarget?: FixtureElement) => sidecarHandlers.get('focusout')!({ target, relatedTarget }),
    hover: (target: FixtureElement) => handlers.get('mouseover')!({ target }),
    leave: (target: FixtureElement, relatedTarget?: FixtureElement) => handlers.get('mouseout')!({ target, relatedTarget }),
    key: (target: FixtureElement, key: string) => {
      let prevented = false;
      handlers.get('keydown')!({ target, key, preventDefault: () => { prevented = true; } });
      return prevented;
    },
    message: (data: unknown) => windowHandlers.get('message')!({ data }),
    scroll: (scrollTop: number) => { timeline.scrollTop = scrollTop; timelineHandlers.get('scroll')!(); },
    scrollMap: (scrollTop: number) => { turnMap.scrollTop = scrollTop; mapHandlers.get('scroll')!(); },
    unknownButton: () => new FixtureElement({ action: 'executeCommand' }),
  };
}

test('only evidence with readable incremental content becomes a detail button', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'available', kind: 'question' }),
    item({ id: 'partial', kind: 'question', availability: 'partial' }),
    item({ id: 'display', kind: 'question', availability: 'none', title: '说明已经完整显示', summary: '' }),
    item({ id: 'missing', kind: 'question', availability: 'unavailable', detail: undefined }),
    item({ id: 'empty', kind: 'question', detail: { title: '空记录', blocks: [] } }),
  ]) });
  // A question to the user is a call row: readable evidence opens in the editor.
  assert.match(html, /class="crow node-button" data-item-id="available" data-tool="Ask"/);
  assert.match(html, /data-item-id="partial"/);
  for (const id of ['display', 'missing', 'empty']) assert.ok(!html.includes(`data-item-id="${id}"`));
  assert.match(renderInlineEvidence({ item: item({ availability: 'partial' }) }), /部分内容/);
  assert.match(html, /未取得可读的记录内容/);
  assert.ok(!html.includes('data-inline-id="empty"'));
});

test('semantic rows are direct detail buttons only when at least one original record has readable evidence', () => {
  const records = [
    item({ id: 'available-row', title: 'available-only' }),
    item({ id: 'partial-row', title: 'partial-only', availability: 'partial' }),
    item({ id: 'display-row', title: 'display-only', availability: 'none' }),
    item({ id: 'missing-row', title: 'missing-only', availability: 'unavailable', detail: undefined }),
    item({ id: 'empty-row', title: 'empty-only', detail: { title: '空记录', blocks: [] } }),
  ];
  const data = session(records);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  assert.equal(actionHtmlRows(html).length, records.length);
  for (const row of projectedRows(data)) {
    const clickable = ['available-row', 'partial-row'].includes(row.items[0].id);
    assert.equal(html.includes(`data-item-id="${attributeValue(row.id)}"`), clickable);
  }
});

test('session navigation and all visible turn groups run newest first without reversing events within turns', () => {
  const data = session([
    item({ id: 'request-1', kind: 'request', title: '用户请求', summary: '第一轮的问题' }), item(),
    item({ id: 'request-2', turnId: 'turn-2', kind: 'request', title: '用户请求', summary: '第二轮的问题' }),
    item({ id: 'tool-2', turnId: 'turn-2' }),
  ]);
  const html = renderSidecar({ projectName: 'project', session: data, nonce });
  assert.match(html, /data-session-id="codex:session-1"/);
  assert.match(html, /<button[^>]*data-lens-turn-id="turn:turn-1"[^>]*aria-pressed="false"/);
  assert.match(html, /<button[^>]*data-lens-turn-id="turn:turn-2"[^>]*aria-pressed="true"/);
  const panels = [...html.matchAll(/<section[^>]*data-turn-panel="([^"]+)"[^>]*>/g)];
  assert.equal(panels.length, 2);
  assert.deepEqual(panels.filter(panel => !/\bhidden\b/.test(panel[0])).map(panel => panel[1]), ['turn:turn-2', 'turn:turn-1']);
  assert.ok(html.indexOf('data-lens-turn-id="turn:turn-2"') < html.indexOf('data-lens-turn-id="turn:turn-1"'));
  assert.ok(html.indexOf('data-turn-panel="turn:turn-2"') < html.indexOf('data-turn-panel="turn:turn-1"'));
  assert.ok(!html.includes('只读观察 · 按需查看证据'));
  assert.ok(!html.includes('你的问题'));
  assert.ok(!html.includes('details class="turn-group"'), 'Historical turns are not full-width accordion cards');
  assert.match(html, /第一轮的问题/);
  assert.match(html, /第二轮的问题/);
  for (const row of projectedRows(data)) assert.equal(html.split(`data-item-id="${attributeValue(row.id)}"`).length - 1, 1);
  assert.match(renderSidecar({ projectName: 'project', session: { ...data, provider: 'claude' }, nonce }), /data-session-id="claude:session-1"/);
});

test('the page head names the turn and steps through turns; session actions and the name live in the view title bar', () => {
  const data = session([item()]);
  data.title = '检查回合目录的阅读体验';
  const html = renderSidecar({ projectName: 'project', session: data, nonce });
  const head = html.match(/<header class="page-head">[\s\S]*?<\/header>/)?.[0];
  assert.ok(head);
  for (const action of ['older', 'newer', 'toc']) assert.match(head, new RegExp(`data-nav="${action}"`));
  // No toolbar of its own: the name, switching and refreshing are VS Code's view title bar.
  assert.ok(!html.includes('class="toolbar"') && !html.includes('session-title') && !html.includes('检查回合目录的阅读体验'));
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const menu = manifest.contributes.menus['view/title'].filter((entry: any) => entry.when === 'view == tickbird.observer').map((entry: any) => entry.command);
  assert.deepEqual(menu, ['tickbird.chooseSession', 'tickbird.refresh', 'tickbird.coverage']);
});

test('目录 lists each turn by its request, latest first, two lines each, without generated titles', () => {
  const data = session([
    item({ kind: 'request', summary: '第一问。后一句不应进入目录。' }),
    item({ id: 'request-2', turnId: 'turn-2', kind: 'request', summary: 'Check example.com please. Another sentence.' }),
    item({ id: 'request-3', turnId: 'turn-3', kind: 'request', summary: '<script>bad()</script> 可以吗？后一句。' }),
    item({ id: 'tool-4', turnId: 'turn-4' }),
  ]);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  const lens = html.match(/<div class="toc-list">([\s\S]*?)<\/div><\/nav>/)?.[1];
  assert.ok(lens);
  assert.deepEqual([...lens.matchAll(/data-lens-turn-id="([^"]+)"/g)].map(match => match[1]), ['turn:turn-4', 'turn:turn-3', 'turn:turn-2', 'turn:turn-1']);
  assert.match(lens, />未取得本轮问题<\/span>/);
  // One block per turn: the request itself, not a first-sentence title repeating it.
  assert.equal(lens.match(/class="turn-lens-title"/g), null);
  assert.match(lens, /class="turn-lens-request">第一问。/);
  assert.match(lens, /Check example.com please\./);
  assert.match(lens, /&lt;script&gt;bad\(\)&lt;\/script&gt; 可以吗？/);
  assert.match(html, /\.toc-list \.turn-lens-request[^}]+-webkit-line-clamp: 2/);
  assert.ok(!lens.includes('<script>'));
});

test('a subagent reads as an Agent call row in its place, named in text and opening its record in the editor', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([item({ kind: 'subagent', title: '子 Agent 返回' })]) });
  // Off the band, a dot coloured by its state (design v10): done here.
  assert.match(html, /<div class="cagents"[^>]*><div class="crun"[^>]*><div class="ctool">Agent<\/div><ol class="cagent-list">/);
  assert.match(html, /<button type="button" class="crow cagent node-button" data-item-id="tool-1" data-tool="Agent" data-state="done"[^>]*><span class="cdot" aria-hidden="true"><\/span><span class="clabel">/);
  assert.match(html, /\.cagent\[data-state="running"\] \.cdot \{ background: var\(--gold\); \}/);
  assert.doesNotMatch(html, /class="record-disclosure/);
});

test('unavailable nonclickable action and subagent rows keep reasons accessible without redundant badges or empty details', () => {
  const records = [
    item({ id: 'missing-subagent', kind: 'subagent', title: '子 Agent 消息', summary: '仅有消息标记，未取得正文。', availability: 'unavailable', detail: undefined }),
    item({ id: 'missing-tool', title: 'exec_command', summary: '当时的返回内容未取得。', status: 'failed', availability: 'unavailable', detail: undefined }),
    item({ id: 'missing-file', kind: 'file-change', title: 'apply_patch', summary: '变更记录未取得。', status: 'running', availability: 'unavailable', detail: undefined }),
  ];
  const html = renderSidecar({ projectName: 'project', nonce, session: session(records) });
  const body = html.match(/<section class="timeline"[\s\S]*?<\/main>/)?.[0];
  assert.ok(body);
  assert.ok(!body.includes('内容不可用'));
  assert.match(body, /aria-label="[^"]*未取得可读的记录内容/);
  assert.match(body, /<div class="crow"[^>]*aria-label="[^"]*未取得可读的记录内容/);
  assert.match(body, /<span class="cbad"[^>]*>failed<\/span>/);
  assert.match(body, /data-status="running"[^>]*(?:title|aria-label)="[^"]*进行中/);
  assert.ok(!body.includes('<i class="cnone">进行中</i>'), 'No word on the row itself');
  assert.ok(!body.includes('data-item-id='));
});

test('unsupported notices and partial or unknown evidence states are not hidden by quieter unavailable rows', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'unsupported', kind: 'notice', title: '待支持：未知结构', summary: '这个结构尚未解释。', availability: 'unavailable', detail: undefined }),
    item({ id: 'partial-subagent', kind: 'subagent', title: '子 Agent 消息', availability: 'partial' }),
    item({ id: 'unknown-tool', title: 'exec_command', status: 'unknown', availability: 'unavailable', detail: undefined }),
  ]) });
  assert.match(html, /<span class="node-title">待支持：未知结构<\/span>/);
  assert.match(html, /<span class="node-summary">这个结构尚未解释。<\/span>/);
  assert.match(html, /未取得可读的记录内容/);
  assert.match(renderInlineEvidence({ item: item({ availability: 'partial' }) }), /部分内容/);
  assert.doesNotMatch(html, /状态未核实/);
});

test('turn selection, expansion and scroll state are scoped to the bound session, including provider', () => {
  const codex = scriptFixture();
  codex.click(codex.lensNav[0]);
  codex.backgrounds[0].open = true;
  codex.backgrounds[0].listeners.get('toggle')!();
  codex.scroll(210);
  assert.equal(codex.state?.sessionId, 'codex:session-1');
  for (const [options, expectedId] of [
    [{ provider: 'claude' as const }, 'claude:session-1'],
    [{ sessionId: 'session-2' }, 'codex:session-2'],
  ] as const) {
    const fixture = scriptFixture({ ...options, state: codex.state });
    assert.equal(fixture.document.body.dataset.sessionId, expectedId);
    assert.deepEqual(fixture.panels.map(panel => panel.hidden), [false, false]);
    assert.deepEqual(fixture.backgrounds.map(group => group.open), [false, false]);
    assert.deepEqual(fixture.focused, []);
  }
});

test('attached context is folded by default and background expansion plus keyboard focus survive refresh', () => {
  const before = scriptFixture();
  assert.deepEqual(before.backgrounds.map(group => group.open), [false, false]);
  before.backgrounds[1].open = true;
  before.backgrounds[1].listeners.get('toggle')!();
  before.focus(before.summaries[1]);
  assert.deepEqual(before.state?.expandedActionIds, ['background:turn:turn-2']);
  assert.equal(before.state?.focusGroupId, 'background:turn:turn-2');
  const refreshed = scriptFixture({ state: before.state });
  assert.deepEqual(refreshed.backgrounds.map(group => group.open), [false, true]);
  assert.deepEqual(refreshed.focused, [{ dataset: { actionGroup: 'background:turn:turn-2' }, preventScroll: true }]);
  assert.deepEqual(before.sent, []);
  refreshed.click(refreshed.node);
  assert.deepEqual(refreshed.sent.at(-1), { type: 'openDetail', itemId: 'tool-1' });
  assert.equal(refreshed.state?.focusGroupId, '');
});

test('obsolete accordion state and missing saved turns do not hide history', () => {
  for (const oldState of [
    { expandedTurnIds: ['turn:turn-1', 'turn:turn-2'] },
    { selectedTurnId: 'turn:removed', expandedTurnIds: ['turn:turn-1'] },
  ]) {
    const fixture = scriptFixture({ state: { sessionId: 'codex:session-1', ...oldState } });
    assert.deepEqual(fixture.panels.map(panel => panel.hidden), [false, false]);
    assert.deepEqual(fixture.backgrounds.map(group => group.open), [false, false]);
  }
});

test('each turn begins with its request then prose while lifecycle noise and raw tool accordions stay absent', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'start', kind: 'notice', title: '回合开始', summary: '回合开始', availability: 'none', detail: undefined }),
    item({ id: 'request', kind: 'request', title: '用户请求', summary: '检查当前实现', availability: 'none', detail: undefined }),
    item({ id: 'prose', kind: 'message', title: '过程说明', summary: '先检查已有实现，再核对行为。', availability: 'none', detail: undefined }),
    item(),
  ]) });
  assert.match(html, /class="csay"/);
  assert.match(html, /先检查已有实现，再核对行为。/);
  assert.ok(!html.includes('>过程说明<'));
  assert.ok(!html.includes('>回合开始<'));
  assert.ok(!html.includes('data-item-id="request"'));
  assert.match(html, /class="turn-question"[\s\S]*检查当前实现/);
  const panel = html.slice(html.indexOf('<section class="turn-panel'));
  assert.ok(panel.indexOf('turn-question') < panel.indexOf('csay'));
  assert.equal(actionHtmlRows(html).length, 1);
  assert.ok(!html.includes('class="action-group"'));
  assert.ok(!html.includes('class="action-members"'));
});

test('request is visible at turn start; attached context stays in the coverage ledger, never a background disclosure', () => {
  const data = session([
    item({ id: 'request-readable', kind: 'request', title: '用户请求', summary: '这一轮只核对会话标题',
      detail: { title: '原始提问', blocks: [{ kind: 'text', label: '提问原文', text: '这一轮只核对会话标题\n额外的可读原文。' }] } }),
    item({ id: 'context-readable', kind: 'context', title: '附带上下文', summary: '当前工作区说明' }),
    item({ id: 'narrative', kind: 'message', title: '过程说明', summary: '我会先核对当前标题。', availability: 'none', detail: undefined }),
  ]);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  const questionStart = html.indexOf('class="turn-question"');
  assert.ok(questionStart >= 0);
  assert.match(html.slice(questionStart), /data-text-id="request-readable"/);
  assert.ok(html.indexOf('这一轮只核对会话标题') < html.indexOf('我会先核对当前标题'));
  assert.ok(!html.includes('turn-background') && !html.includes('附带背景'));
  assert.ok(!html.includes('context-readable'));
});

test('a failed narrative keeps its visible failure label without generic process or availability noise', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'failed-note', kind: 'message', title: '过程说明', summary: '验证失败，正在检查原因。',
      status: 'failed', availability: 'none', detail: undefined }),
  ]) });
  const narrative = html.match(/<div class="csay"[^>]*>[\s\S]*?<\/div>/)?.[0];
  assert.ok(narrative);
  assert.match(narrative, /data-status="failed"/);
  assert.match(narrative, /验证失败，正在检查原因。/);
  assert.match(narrative, />失败</);
  assert.ok(!narrative.includes('过程说明'));
  assert.ok(!narrative.includes('仅展示'));
});

test('semantic action rows separate type and purpose and open source-backed evidence directly', () => {
  const skill = item({ id: 'skill-wrapper', title: 'functions.exec', summary: 'exec', result: 'not-observed', detail: {
    title: '记录调用', blocks: [{ kind: 'code', label: '记录中的调用参数',
      text: 'text(await tools.exec_command({cmd:"head -n 240 /repo/.agents/skills/openai-docs/SKILL.md"}));' }],
  } });
  const web = item({ id: 'web-wrapper', title: 'functions.exec', summary: 'exec', result: 'not-observed', detail: {
    title: '记录调用', blocks: [{ kind: 'code', label: '记录中的调用参数', text: [
      'text(await tools.web__run({search_query:[{q:"VS Code API"}]}));',
      'text(await tools.web__run({search_query:[{q:"VS Code API"}]}));',
    ].join('\n') }],
  } });
  const results = Array.from({ length: 3 }, (_, index) => item({ id: `web-result-${index + 1}`, title: 'Web 来源',
    status: 'info', detail: { title: '来源内容', blocks: [{ kind: 'text', label: '来源正文', text: `来源 ${index + 1}` }] },
  }));
  const data = session([skill, web, ...results]);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  const rows = actionHtmlRows(html);
  // As in the terminal, a search's sources are a record of that search: they open from it and take no row.
  const shown = projectedRows(data).filter(row => !row.items.every(record => record.title === 'Web 来源'));
  assert.equal(rows.length, shown.length);
  assert.ok(!html.includes('class="action-group"'));
  assert.ok(!html.includes('class="action-members"'));
  const skillRow = rows.find(row => row.includes('data-tool="Skill"'));
  const webRow = rows.find(row => row.includes('VS Code API'));
  assert.ok(skillRow && webRow);
  assert.match(html, /<div class="ctool">Skill<\/div>/);
  assert.match(skillRow, /openai-docs · 读取定义/);
  assert.match(webRow, /data-tool="WebSearch"/);
  assert.match(webRow, /class="clabel [a-z]+">VS Code API/);
  assert.equal(rows.filter(row => row.includes('VS Code API')).length, 2, 'Repeated wrapper inputs remain distinct occurrences');
  for (const row of rows) {
    assert.match(row, /^<button/, 'A readable row opens its evidence directly');
    assert.match(row, /data-tool="(?:Skill|WebSearch|WEB)"/);
    assert.doesNotMatch(row, /class="action-symbol"/);
    assert.ok(!row.includes('functions.exec'));
    assert.ok(!row.includes('>exec<'));
    assert.ok(!row.includes('次调用'), 'Source records are not labelled as verified call executions');
  }
  for (const projected of shown) {
    assert.ok(html.includes(`data-item-id="${attributeValue(projected.id)}"`), 'Each row opens its own evidence');
    const evidence = resolveOutlineEvidence(data, projected.id);
    assert.ok(evidence, 'Each row resolves through the same evidence path used by the extension');
    assert.deepEqual(evidence.items ?? [evidence.item], projected.items);
  }
});

test('a source-result-only action row still identifies its evidence instead of disappearing', () => {
  const data = session([
    item({ id: 'source-only', title: 'Web 来源', status: 'info' }),
  ]);
  const rows = actionHtmlRows(renderSidecar({ projectName: 'project', nonce, session: data }));
  assert.equal(rows.length, 1);
  // Sources with no search before them are the search itself.
  assert.match(rows[0], /data-tool="WebSearch"/);
  assert.ok(!rows[0].includes('次调用'));
  assert.ok(resolveOutlineEvidence(data, projectedRows(data)[0].id));
});

test('a semantic row opens aggregate evidence in one click without expanding background content', () => {
  const row = projectedRows(session([item()]))[0];
  const fixture = scriptFixture();
  fixture.node.dataset.itemId = row.id;
  fixture.click(fixture.node);
  assert.deepEqual(fixture.sent.at(-1), { type: 'openDetail', itemId: row.id });
  assert.equal(fixture.state?.selectedId, row.id);
  assert.deepEqual(fixture.backgrounds.map(background => background.open), [false, false]);
});

test('each input row expands directly without a redundant action directory or fabricated output', () => {
  const data = session([readInput('input-1', { status: 'unknown' }), readInput('input-2', { result: 'empty' })]);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  assert.doesNotMatch(html, /<details class="action-fold"/);
  assert.equal(actionHtmlRows(html).length, 2);
  assert.doesNotMatch(html, /成功|状态未核实/);
  assert.ok(!html.includes('/project/input-1.ts'), 'Closed input is loaded on demand');
  for (const row of projectedRows(data)) {
    assert.ok(html.includes(`data-item-id="${attributeValue(row.id)}"`));
    const evidence = resolveOutlineEvidence(data, row.id)!;
    assert.deepEqual(evidence.items, row.items);
    assert.doesNotMatch(renderInlineEvidence(evidence), /data-io="output"/);
  }
});

test('repeated adjacent inputs retain counts without an extra outer directory', () => {
  const first = readInput('repeat-1');
  const html = renderSidecar({ projectName: 'project', nonce, session: session([first, { ...first, id: 'repeat-2' }]) });
  assert.doesNotMatch(html, /<details class="action-fold"/);
  assert.equal(actionHtmlRows(html).length, 1);
  assert.match(html, /class="clabel[^"]*">[^<]* · 2 次<\/span>/);
});

test('readable outputs are direct entries and one shared wrapper output is never attributed to individual input atoms', () => {
  const wrapper = item({ id: 'shared-wrapper', title: 'functions.exec', result: 'readable', detail: {
    title: '编排记录', blocks: [
      { kind: 'code', label: '记录中的调用参数', text: 'text(await tools.exec_command({cmd:"head -n 8 /project/a.ts"})); text(await tools.exec_command({cmd:"npm test"}));' },
      { kind: 'text', label: '当时返回的内容', text: 'SHARED PUBLIC OUTPUT' },
    ],
  } });
  const direct = readInput('direct-result', { result: 'readable' });
  direct.detail!.blocks.push({ kind: 'text', label: '当时返回的内容', text: 'DIRECT PUBLIC OUTPUT' });
  const data = session([wrapper, direct]);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  const folded = html.match(/<details class="action-fold"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.equal(folded, undefined, 'Bash inputs remain visible in sequence');
  assert.equal((html.match(/data-tool="Bash"/g) ?? []).length, 1);
  const rows = actionHtmlRows(html);
  assert.ok(rows.every(row => !row.includes('返回 · ')));
  assert.ok(rows.every(row => !row.includes('functions.exec') && !row.includes('>exec<')));
  // The wrapper's one output is a record of its calls, as in the terminal: no row, and the calls inside it do not each claim it.
  assert.ok(rows.every(row => !row.includes('data-tool="OUT"') && !row.includes('data-tool="Output"')));
  const resultRows = projectedRows(data).filter(row => row.id.startsWith('action-result:'));
  assert.equal(resultRows.length, 1);
  const shared = resolveOutlineEvidence(data, resultRows[0].id)!;
  assert.deepEqual(shared.items, [wrapper]);
  assert.ok(JSON.stringify(shared).includes('SHARED PUBLIC OUTPUT'));
});

test('failed, running, partial, unreadable, unsupported and missing-result metadata remain outside folded runs', () => {
  const records = [readInput('ordinary-1'), readInput('ordinary-2'),
    readInput('failed', { status: 'failed' }),
    readInput('running', { status: 'running' }),
    readInput('partial', { result: 'partial', availability: 'partial' }),
    readInput('unreadable', { result: 'unreadable', availability: 'unavailable', detail: undefined }),
    readInput('unclassified', { result: undefined }),
    item({ id: 'question', kind: 'question', title: '需要用户确认' }),
    item({ id: 'unsupported', kind: 'notice', title: '待支持：新结构', status: 'unknown', availability: 'unavailable', detail: undefined }),
  ];
  const html = renderSidecar({ projectName: 'project', nonce, session: session(records) });
  assert.doesNotMatch(html, /<details class="action-fold"/);
  for (const state of ['failed', '进行中', '待支持：新结构']) assert.ok(html.includes(state));
  assert.ok(html.includes('data-item-id="question"'));
  assert.ok(html.includes('unclassified.ts'));
  const evidence = resolveOutlineEvidence(session(records), projectedRows(session(records)).find(row => row.items.some(item => item.id === 'partial'))!.id)!;
  assert.match(renderInlineEvidence(evidence), /部分可读/);
});

test('action directory expansion and summary focus persist within a session, without opening host details', () => {
  const before = scriptFixture({ foldActions: true });
  assert.equal(before.actionFolds[0].open, false);
  before.focus(before.actionSummaries[0]);
  before.actionFolds[0].open = true;
  before.actionFolds[0].listeners.get('toggle')!();
  before.scroll(140);
  assert.deepEqual(before.state?.expandedActionIds, ['action-section:fixture-inputs']);
  assert.equal(before.state?.focusGroupId, 'action-section:fixture-inputs');
  assert.deepEqual(before.sent, []);
  const refreshed = scriptFixture({ foldActions: true, state: before.state });
  assert.equal(refreshed.actionFolds[0].open, true);
  assert.equal(refreshed.timeline.scrollTop, 140);
  assert.deepEqual(refreshed.focused, [{ dataset: { actionGroup: 'action-section:fixture-inputs' }, preventScroll: true }]);
  refreshed.click(refreshed.node);
  assert.deepEqual(refreshed.sent.at(-1), { type: 'openDetail', itemId: 'tool-1' });
  refreshed.actionFolds[0].open = false;
  refreshed.actionFolds[0].listeners.get('toggle')!();
  const collapsed = scriptFixture({ foldActions: true, state: refreshed.state });
  assert.equal(collapsed.actionFolds[0].open, false);
  assert.deepEqual(collapsed.focused, [], 'A hidden input button cannot regain focus after its directory is collapsed');
  const other = scriptFixture({ foldActions: true, state: before.state, provider: 'claude' });
  assert.equal(other.actionFolds[0].open, false);
  assert.equal(other.timeline.scrollTop, 0);
});

test('refresh clears vanished row selection and item focus without selecting substitute evidence or moving the reader', () => {
  const before = scriptFixture({ nodeId: 'display-action-row:previous-members' });
  before.click(before.node);
  before.scroll(160);
  const refreshed = scriptFixture({ nodeId: 'display-action-row:new-members', state: before.state });
  assert.equal(refreshed.state?.selectedId, '');
  assert.equal(refreshed.state?.focusId, '');
  assert.equal(refreshed.state?.selectedTurnId, before.state?.selectedTurnId);
  assert.equal(refreshed.timeline.scrollTop, 160);
  assert.equal(refreshed.node.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(refreshed.focused, []);
  assert.deepEqual(refreshed.sent, []);
  before.focus(before.refresh);
  const toolbarRefresh = scriptFixture({ nodeId: 'display-action-row:new-members', state: before.state });
  assert.equal(toolbarRefresh.state?.selectedId, '');
  assert.deepEqual(toolbarRefresh.focused, [{ dataset: { action: 'refresh' }, preventScroll: true }]);
  assert.equal(toolbarRefresh.timeline.scrollTop, 160);
  const staleSummary = scriptFixture({ state: { ...before.state, focusAction: '', focusGroupId: 'removed-directory' } });
  assert.equal(staleSummary.state?.focusGroupId, '');
  assert.deepEqual(staleSummary.focused, []);
});

test('a refreshed aggregate split cannot keep selection or focus on a silently narrowed evidence row', () => {
  const first = readInput('same-action-first');
  const second = { ...first, id: 'same-action-second' };
  const beforeSession = session([first, second]);
  const oldRow = projectedRows(beforeSession)[0];
  assert.deepEqual(oldRow.items, [first, second]);
  const afterSession = session([{ ...first, result: 'readable', detail: { ...first.detail!, blocks: [
    ...first.detail!.blocks, { kind: 'text', label: '当时返回的内容', text: 'first return' },
  ] } }, second]);
  const newRows = projectedRows(afterSession);
  assert.equal(newRows.length, 2);
  assert.ok(newRows.every(row => row.id !== oldRow.id));
  assert.equal(resolveOutlineEvidence(afterSession, oldRow.id), undefined, 'The old membership cannot resolve to either new subset');
  const before = scriptFixture({ turnCount: 1, nodeId: oldRow.id });
  before.click(before.node);
  before.scroll(145);
  const refreshed = scriptFixture({ turnCount: 1, nodeId: newRows[0].id, state: before.state });
  assert.equal(refreshed.state?.selectedId, '');
  assert.equal(refreshed.state?.focusId, '');
  assert.equal(refreshed.timeline.scrollTop, 145);
  assert.deepEqual(refreshed.focused, []);
  assert.deepEqual(refreshed.sent, []);
});

test('a later unchanged action keeps selection and focus when an earlier action fails and changes group boundaries', () => {
  const first = readInput('earlier-action');
  const later = readInput('unchanged-later');
  const beforeSession = session([first, later]);
  const afterSession = session([{ ...first, status: 'failed' }, later]);
  const beforeRow = projectedRows(beforeSession).find(row => row.items.includes(later))!;
  const afterRow = projectedRows(afterSession).find(row => row.items.includes(later))!;
  assert.equal(afterRow.id, beforeRow.id, 'Unchanged semantic input and exact source membership retain identity');
  assert.deepEqual(resolveOutlineEvidence(afterSession, afterRow.id)?.items, [later]);
  for (const data of [beforeSession, afterSession]) {
    assert.ok(renderSidecar({ projectName: 'project', nonce, session: data }).includes(`data-item-id="${attributeValue(beforeRow.id)}"`));
  }
  const before = scriptFixture({ turnCount: 1, nodeId: beforeRow.id, foldActions: true });
  before.actionFolds[0].open = true;
  before.actionFolds[0].listeners.get('toggle')!();
  before.click(before.node);
  before.scroll(175);
  const refreshed = scriptFixture({ turnCount: 1, nodeId: afterRow.id, state: before.state });
  assert.equal(refreshed.state?.selectedId, beforeRow.id);
  assert.equal(refreshed.state?.focusId, beforeRow.id);
  assert.equal(refreshed.node.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(refreshed.focused, [{ dataset: { itemId: beforeRow.id }, preventScroll: true }]);
  assert.equal(refreshed.timeline.scrollTop, 175);
  assert.deepEqual(refreshed.state?.expandedActionIds, [], 'Removed group state cannot recreate the old directory');
  assert.deepEqual(refreshed.sent, []);
});

test('a shared Bash wrapper keeps visible input identities after a readable return arrives', () => {
  const wrapper = item({ id: 'later-return', title: 'functions.exec', result: 'not-observed', detail: {
    title: '调用记录', blocks: [{ kind: 'code', label: '记录中的调用参数', text: 'text(await tools.exec_command({cmd:"head -n 8 /project/a.ts"})); text(await tools.exec_command({cmd:"npm test"}));' }],
  } });
  const beforeSession = session([wrapper]);
  const afterSession = session([{ ...wrapper, result: 'readable', detail: {
    ...wrapper.detail!, blocks: [...wrapper.detail!.blocks, { kind: 'text', label: '当时返回的内容', text: 'new result' }],
  } }]);
  const before = renderSidecar({ projectName: 'project', nonce, session: beforeSession });
  const after = renderSidecar({ projectName: 'project', nonce, session: afterSession });
  const directoryId = (html: string) => html.match(/<details class="action-fold" data-action-group="([^"]+)"/)?.[1];
  assert.equal(directoryId(before), undefined);
  assert.equal(directoryId(after), undefined);
  assert.equal((after.match(/data-tool="(?:OUT|Output)"/g) ?? []).length, 0, 'The return is a record of the calls, with no row of its own');
  const sourceDirectoryId = (data: SessionData) => {
    const group = outlineTurn(groupSessionTurns(data)[0]).nodes.find(node => node.kind === 'actions');
    assert.ok(group && group.kind === 'actions');
    return actionRowSections(group).find(section => section.kind === 'steps')!.id;
  };
  const sourceId = sourceDirectoryId(beforeSession);
  assert.equal(sourceDirectoryId(afterSession), sourceId);
  assert.deepEqual(projectedRows(beforeSession).map(row => row.id), projectedRows(afterSession).filter(row => !row.id.startsWith('action-result:')).map(row => row.id));
  const rowId = projectedRows(beforeSession)[0].id;
  const fixture = scriptFixture({ nodeId: rowId });
  fixture.click(fixture.node);
  fixture.scroll(170);
  const refreshed = scriptFixture({ nodeId: rowId, state: fixture.state });
  assert.equal(refreshed.timeline.scrollTop, 170);
  assert.equal(refreshed.state?.selectedTurnId, fixture.state?.selectedTurnId);
  assert.deepEqual(refreshed.focused, [{ dataset: { itemId: rowId }, preventScroll: true }]);
});

test('truly empty ended turns disappear from the page and 目录 without renumbering substantive turns', () => {
  const empty = item({ id: 'empty-ended', turnId: 'turn-2', kind: 'notice', title: '回合结束', summary: '', availability: 'none', detail: undefined });
  const active = item({ id: 'active', turnId: 'turn-4', kind: 'notice', title: '回合开始', summary: '', status: 'running', availability: 'none', detail: undefined });
  const data = session([readInput('first'), empty, readInput('third', { turnId: 'turn-3' }), active]);
  const original = JSON.stringify(data);
  const html = renderSidecar({ projectName: 'project', nonce, session: data });
  for (const attribute of ['data-turn-panel', 'data-lens-turn-id']) {
    assert.ok(!html.includes(`${attribute}="turn:turn-2"`));
    assert.ok(html.includes(`${attribute}="turn:turn-3"`));
    assert.ok(html.includes(`${attribute}="turn:turn-4"`), 'An active begin-only turn remains observable');
  }
  assert.match(html, /data-turn-panel="turn:turn-3" data-ordinal="3"[^>]* aria-label="第 3 轮"/);
  assert.equal(JSON.stringify(data), original, 'Display filtering cannot delete source or coverage data');
  const emptyOnly = renderSidecar({ projectName: 'project', nonce, session: session([empty]) });
  assert.match(emptyOnly, /暂没有可展示的过程/);
  assert.ok(!emptyOnly.includes('data-turn-panel="'));
});

test('refresh cannot resurrect a filtered empty turn and still restores a surviving reading anchor', () => {
  const before = scriptFixture({ turnCount: 3 });
  before.click(before.lensNav[1]);
  before.scroll(1120);
  const removed = scriptFixture({ turnCount: 3, hiddenTurns: [2], state: before.state });
  assert.ok(!removed.panels.some(panel => panel.dataset.turnPanel === 'turn:turn-2'));
  assert.ok(!removed.nav.some(button => button.dataset.turnId === 'turn:turn-2'));
  assert.ok(!removed.lensNav.some(button => button.dataset.lensTurnId === 'turn:turn-2'));
  assert.notEqual(removed.state?.selectedTurnId, 'turn:turn-2');
  assert.deepEqual(removed.focused, []);
  const surviving = scriptFixture({ turnCount: 3 });
  surviving.click(surviving.lensNav[2]);
  surviving.scroll(2140);
  const refreshed = scriptFixture({ turnCount: 3, hiddenTurns: [2], state: surviving.state });
  assert.equal(refreshed.timeline.scrollTop, 2140, 'The surviving turn, where the reader was in it');
  assert.equal(refreshed.state?.selectedTurnId, 'turn:turn-1');
  assert.equal(refreshed.turnLens.hidden, true);
});
test('action rows expose pending, running and partial evidence while failure remains its own row', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'done' }), item({ id: 'pending', status: 'unknown' }), item({ id: 'running', status: 'running' }),
    item({ id: 'partial', availability: 'partial' }),
    item({ id: 'failed', status: 'failed' }),
  ]) });
  const rows = actionHtmlRows(html);
  assert.ok(rows.length >= 2);
  assert.ok(rows.some(row => /进行中/.test(row)));
  assert.ok(!rows.some(row => /未核实/.test(row)));
  assert.ok(rows.some(row => /data-status="info"/.test(row)), 'No invented result state in compact rows');
  assert.match(renderInlineEvidence({ item: item({ availability: 'partial' }) }), /部分内容/);
  const failed = rows.filter(row => /data-status="failed"/.test(row));
  assert.equal(failed.length, 1);
  assert.match(failed[0], />failed</);
  assert.ok(!rows.some(row => />(?:已完成|成功|已成功)</.test(row)));
});

test('user-controlled text, identifiers, labels and sources cannot inject HTML or scripts', () => {
  const attack = '"><img src=x onerror=alert(1)><script>evil()</script>&';
  const malicious = item({ id: attack, title: attack, summary: attack, sessionId: attack,
    sources: [{ file: attack, line: 8, recordId: attack }],
    detail: { title: attack, provenance: attack, notice: attack, blocks: [{ kind: 'text', label: attack, text: attack }] },
  });
  const data = session([malicious]);
  data.id = attack; data.title = attack; data.warnings = [attack];
  for (const html of [renderSidecar({ projectName: attack, session: data, nonce }), renderDetail({ item: malicious, provider: 'codex', kept: false, nonce })]) {
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>evil()'));
    assert.match(html, /&lt;script&gt;evil\(\)&lt;\/script&gt;/);
    assert.equal((html.match(/<script nonce=/g) ?? []).length, 1);
    assert.ok(!html.includes('onclick='));
  }
});

test('CSP forbids external content and rejects nonce injection', () => {
  const html = renderSidecar({ projectName: 'project', nonce });
  assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /img-src data:/);
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.match(html, /style-src &#39;nonce-renderer-test-nonce&#39;/);
  assert.match(html, /script-src &#39;nonce-renderer-test-nonce&#39;/);
  assert.ok(!html.includes('unsafe-inline'));
  assert.throws(() => renderSidecar({ projectName: 'project', nonce: "x' 'unsafe-inline" }), /nonce/);
});

test('a final answer folds to one line under Final Answer, after the process, and opens to full Markdown in place', () => {
  const answer = item({ kind: 'answer', title: '历史回答', summary: 'fallback',
    detail: { title: '原始回答', blocks: [{ kind: 'text', label: '正文', text: '**有格式的回答**\n[link](command:danger)' }] },
  });
  const html = renderSidecar({ projectName: 'project', session: session([item({ id: 'before' }), answer]), nonce });
  const fold = /<details class="cfold fanswer"[^>]*><summary><div class="tlabel">Final Answer<\/div><span class="fline"><span class="ftext">([^<]*)<\/span>[\s\S]*?<\/summary><div class="fbody">([\s\S]*?)<\/div><\/details>/.exec(html);
  assert.ok(fold, 'The answer under its label, folded');
  assert.equal(fold[1], '有格式的回答 link', 'One line of it, as words: no Markdown marks');
  assert.match(fold[2], /<strong>有格式的回答<\/strong>/, 'Opened, the whole answer');
  assert.ok(html.indexOf('data-observation-key="') < html.indexOf('class="cfold fanswer"'));
  assert.ok(!html.includes('data-item-id="tool-1"'));
  assert.ok(!html.includes('<a '));
});

test('aggregated action details retain ordered original inputs, outputs, status, provenance and sources', () => {
  const first = item({ id: 'test-first', title: 'exec_command', sources: [{ file: '/project/session.jsonl', line: 21, recordId: 'first-call' }],
    detail: { title: '首条测试记录', provenance: '首条记录的来源说明', blocks: [
      { kind: 'json', label: '记录中的调用参数', text: '{"cmd":"npm test"}' },
      { kind: 'code', label: '当时返回的内容', text: 'FIRST RESULT: PASS' },
    ] } });
  const second = item({ id: 'test-second', title: 'exec_command', status: 'running', availability: 'partial',
    sources: [{ file: '/project/session.jsonl', line: 34, recordId: 'second-call', block: 2 }],
    detail: { title: '第二条测试记录', provenance: '第二条记录的来源说明', notice: '后续输出尚未取得', blocks: [
      { kind: 'json', label: '记录中的调用参数', text: '{"cmd":"npm test"}' },
      { kind: 'code', label: '当时返回的内容', text: 'SECOND RESULT: waiting<script>no()</script>' },
    ] } });
  const data = session([first, second]);
  const rows = legacyRows(data);
  assert.equal(rows.length, 1);
  const evidence = resolveOutlineEvidence(data, rows[0].id);
  assert.ok(evidence?.items);
  const html = renderDetail({ ...evidence, provider: 'codex', kept: false, nonce });
  assert.equal((html.match(/class="evidence-record"/g) ?? []).length, 2);
  assert.ok(html.indexOf('FIRST RESULT: PASS') < html.indexOf('SECOND RESULT: waiting'));
  assert.ok((html.match(/npm test/g) ?? []).length >= 2, 'Each original call input remains available');
  for (const expected of ['首条记录的来源说明', '第二条记录的来源说明', '后续输出尚未取得', 'first-call', 'second-call', '内容块 2']) assert.ok(html.includes(expected));
  assert.match(html, /已完成/);
  assert.match(html, /进行中/);
  assert.match(html, /部分内容|已取得的部分/);
  assert.match(html, /\/project\/session\.jsonl:21/);
  assert.match(html, /\/project\/session\.jsonl:34/);
  assert.match(html, /waiting&lt;script&gt;no\(\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>no()'));
  assert.ok(!html.includes('当前没有可呈现的详情证据'), 'An intentionally empty synthetic header is not mistaken for missing original evidence');
  assert.equal((html.match(/<button[^>]*data-action="keep"/g) ?? []).length, 1);
});

test('single-source aggregate details have one semantic title and retain original record metadata in a closed source disclosure', () => {
  const original = item({ id: 'original-source-record', title: 'exec_command', status: 'completed', result: 'readable',
    sources: [{ file: '/project/evidence-source.jsonl', line: 27, recordId: 'source-record-id', block: 0 }],
    detail: { title: '原始命令执行记录', provenance: 'ORIGINAL_PROVENANCE <verbatim>', blocks: [
      { kind: 'json', label: '记录中的调用参数', text: '{"cmd":"npm test"}' },
      { kind: 'code', label: '当时返回的内容', text: 'VISIBLE TEST OUTPUT' },
    ] },
  });
  const header = item({ id: 'display-action-row:semantic', title: '测试 · npm test', summary: '1 条来源记录',
    detail: { title: '测试 · npm test', blocks: [], provenance: '按动作整理的来源记录' },
  });
  const html = renderDetail({ item: header, items: [original], provider: 'codex', kept: false, nonce });
  const { main, sources, primary } = detailRegions(html);
  assert.equal((primary.match(/<h1\b/g) ?? []).length, 1);
  assert.match(primary, /<h1[^>]*>测试 · npm test<\/h1>/);
  assert.ok(!/<h2[^>]*>记录 1(?:\s|·)/.test(primary), 'A sole original record does not repeat the aggregate header');
  assert.ok(!primary.includes('1 条来源记录，按原始顺序核对'), 'Aggregate technical explanation does not precede the readable content');
  assert.match(primary, /Codex/);
  assert.match(primary, /已完成/);
  assert.match(primary, /VISIBLE TEST OUTPUT/);
  assert.equal(sources.length, 1);
  assert.ok(!/\bopen(?:\s|=|>)/.test(sources[0].split('>')[0] + '>'));
  for (const metadata of ['original-source-record', 'exec_command', '原始命令执行记录',
    '/project/evidence-source.jsonl:27', 'source-record-id', '内容块 0', 'session-1', 'turn-1']) {
    assert.ok(sources[0].includes(metadata), `Source disclosure retains ${metadata}`);
  }
  assert.ok(!primary.includes('/project/evidence-source.jsonl'));
  assert.match(sources[0], /ORIGINAL_PROVENANCE &lt;verbatim&gt;/);
  assert.ok(!primary.includes('ORIGINAL_PROVENANCE'));
  assert.equal((main.match(/data-action="keep"/g) ?? []).length, 1);
});

test('detail source disclosures retain every precise source and provenance field without mutating the source record', () => {
  const original = item({ id: 'source-fields', sessionId: 'source-session', turnId: 'source-turn', title: 'Bash',
    sources: [
      { file: '/project/first<&>.jsonl', line: 1, recordId: 'record<first>', block: 0 },
      { file: '/project/second.jsonl', line: 54, recordId: 'record-second', block: 7 },
    ],
    detail: { title: '当时的命令记录', provenance: '说明原文：仅从这两处来源核对。', blocks: [
      { kind: 'json', label: '当时调用参数', text: '{"command":"pwd"}' },
      { kind: 'text', label: '输出正文', text: 'SOURCE-FIELD TEST OUTPUT' },
    ] },
  });
  const before = JSON.stringify(original);
  const { sources, primary } = detailRegions(renderDetail({ item: original, provider: 'claude', kept: true, nonce }));
  assert.equal(sources.length, 1);
  const metadata = sources.join('');
  for (const expected of ['source-fields', 'source-session', 'source-turn', 'Bash', '当时的命令记录',
    '/project/first&lt;&amp;&gt;.jsonl:1', 'record&lt;first&gt;', '内容块 0', '/project/second.jsonl:54', 'record-second', '内容块 7']) assert.ok(metadata.includes(expected), expected);
  assert.ok(metadata.indexOf('first&lt;&amp;&gt;.jsonl') < metadata.indexOf('second.jsonl'));
  assert.ok(!primary.includes('first&lt;&amp;&gt;.jsonl'));
  assert.ok(metadata.includes('说明原文：仅从这两处来源核对。'));
  assert.ok(!primary.includes('说明原文：仅从这两处来源核对。'));
  assert.match(primary, /SOURCE-FIELD TEST OUTPUT/);
  assert.match(primary, /Claude Code/);
  assert.match(primary, /data-action="keep" disabled>已保留/);
  assert.equal(JSON.stringify(original), before);
});

test('source notes remain closed and obsolete Markdown boilerplate is not injected', () => {
  const generic = [
    '会话当时记录的内容；未读取当前文件，也未执行记录中的调用。',
    '来自当时保存的会话记录；未执行调用，也未读取当前文件或引用目标。',
  ];
  for (const provenance of generic) {
    const original = item({ kind: 'message', detail: { title: '公开说明原文', provenance, blocks: [
      { kind: 'text', label: '说明正文', text: '**公开说明** 保留原文。' },
    ] } });
    const { sources, primary } = detailRegions(renderDetail({ item: original, provider: 'codex', kept: false, nonce }));
    assert.equal(sources.length, 1);
    assert.ok(sources[0].includes(provenance));
    assert.ok(!sources[0].includes('包含 Markdown 标记'));
    assert.ok(!primary.includes(provenance));
    assert.ok(!primary.includes('包含 Markdown 标记'));
    assert.ok(primary.includes('**公开说明** 保留原文。'));
    const explicitBoundary = `${provenance}后续返回尚未取得。`;
    const boundary = detailRegions(renderDetail({ item: { ...original, detail: { ...original.detail!, provenance: explicitBoundary } }, provider: 'codex', kept: false, nonce }));
    assert.ok(boundary.sources.join('').includes(explicitBoundary), 'Source explanations remain available outside the primary reading surface');
  }
});

test('short availability and failure states stay visible while full source notes stay closed', () => {
  const partial = item({ status: 'failed', availability: 'partial', detail: {
    title: '失败测试的部分输出', provenance: '只读来源说明', notice: '源输出已截断：其余内容未取得。',
    blocks: [{ kind: 'code', label: '保留的输出', text: 'FAIL preserved output' }],
  } });
  const partialRegions = detailRegions(renderDetail({ item: partial, provider: 'codex', kept: false, nonce }));
  assert.ok(partialRegions.sources.length > 0);
  for (const expected of ['失败', '部分内容', 'FAIL preserved output']) {
    assert.ok(partialRegions.primary.includes(expected), `${expected} must not require expanding source metadata`);
  }
  assert.ok(partialRegions.sources.join('').includes('源输出已截断：其余内容未取得。'));
  const missing = detailRegions(renderDetail({ item: item({ availability: 'unavailable', detail: undefined }), provider: 'claude', kept: false, nonce }));
  assert.ok(missing.sources.length > 0);
  assert.match(missing.primary, /内容不可用/);
  assert.ok(!missing.primary.includes('成功'));
  for (const disclosure of [...partialRegions.sources, ...missing.sources]) {
    assert.ok(!/\bopen(?:\s|=|>)/.test(disclosure.split('>')[0] + '>'));
  }
});

test('detail removes the explanation wall and preserves distinct full notes in sources', () => {
  const generatedWarning = '仅呈现已取得的部分内容；缺失或截断部分不代表没有信息。';
  const exact = detailRegions(renderDetail({ item: item({ availability: 'partial', detail: {
    title: '部分记录', notice: generatedWarning, blocks: [{ kind: 'text', label: '正文', text: 'PRESERVED BODY' }],
  } }), provider: 'codex', kept: false, nonce }));
  assert.equal(exact.primary.split(generatedWarning).length - 1, 0, 'No explanation wall before content');
  assert.equal(exact.sources.join('').split(generatedWarning).length - 1, 1);
  const distinct = `${generatedWarning}\n另有附件未取得；不能据此判断其内容为空。`;
  const different = detailRegions(renderDetail({ item: item({ availability: 'partial', detail: {
    title: '部分记录', notice: distinct, blocks: [{ kind: 'text', label: '正文', text: 'PRESERVED BODY' }],
  } }), provider: 'codex', kept: false, nonce }));
  assert.ok(different.sources.join('').includes(distinct), 'Full record notes remain in sources');
  assert.ok(!different.primary.includes(distinct));
});

test('detail result-state hints distinguish missing, empty and unreadable returns without deriving success from readable input', () => {
  for (const [result, expected] of [
    ['not-observed', '尚未取得返回'], ['empty', '已取得空返回'],
    ['unreadable', '返回尚不可读'], ['partial', '返回仅部分可读'],
  ] as const) {
    const original = readInput('result-state-input', { result, status: 'unknown', availability: 'available' });
    const { primary } = detailRegions(renderDetail({ item: original, provider: 'codex', kept: false, nonce }));
    assert.ok(primary.includes(expected));
    assert.ok(!primary.includes('状态未核实'));
    assert.ok(primary.includes('result-state-input.ts'), 'Readable original input remains accessible regardless of result availability');
    assert.ok(!primary.includes('data-status="completed"'));
    assert.ok(!primary.includes('已成功'));
  }
});

test('detail metadata does not manufacture source positions when no precise source reference was retained', () => {
  const { primary, sources } = detailRegions(renderDetail({ item: item({ sources: [] }), provider: 'codex', kept: false, nonce }));
  assert.equal(sources.length, 1);
  assert.match(sources[0], /来源与记录信息 · 0 处/);
  assert.match(sources[0], /尚无可核对的来源位置/);
  assert.ok(!sources[0].includes('/project/session.jsonl'));
  assert.match(primary, /PASS example.test.ts/);
});

test('multiple detail source records keep separate ordered content and visible per-record states after technical metadata is folded', () => {
  const first = item({ id: 'ordered-first', status: 'failed', title: 'exec_command', detail: {
    title: '第一条来源', provenance: 'FIRST PROVENANCE', blocks: [
      { kind: 'json', label: 'FIRST INPUT', text: '{"cmd":"npm test"}' },
      { kind: 'code', label: 'FIRST OUTPUT', text: 'FIRST FAILED OUTPUT' },
    ],
  } });
  const second = item({ id: 'ordered-second', status: 'running', availability: 'partial', title: 'exec_command', detail: {
    title: '第二条来源', provenance: 'SECOND PROVENANCE', notice: '第二条输出尚未收全', blocks: [
      { kind: 'json', label: 'SECOND INPUT', text: '{"cmd":"npm test"}' },
      { kind: 'code', label: 'SECOND OUTPUT', text: 'SECOND RUNNING OUTPUT' },
    ],
  } });
  const header = item({ title: '测试 · npm test', status: 'failed', availability: 'partial', detail: { title: '测试 · npm test', blocks: [] } });
  const { primary, sources } = detailRegions(renderDetail({ item: header, items: [first, second], provider: 'codex', kept: false, nonce }));
  const records = primary.split(/(?=<section\b[^>]*data-source-item-id=)/).filter(part => part.startsWith('<section'));
  assert.equal(records.length, 2, 'Multiple originals remain distinct record sections');
  assert.match(records[0], /data-source-item-id="ordered-first"/);
  assert.match(records[0], /失败/);
  assert.match(records[0], /FIRST FAILED OUTPUT/);
  assert.match(records[1], /data-source-item-id="ordered-second"/);
  assert.match(records[1], /进行中/);
  assert.match(records[1], /部分内容/);
  assert.ok(sources.join('').includes('第二条输出尚未收全'));
  const labels = ['FIRST INPUT', 'FIRST OUTPUT', 'SECOND INPUT', 'SECOND OUTPUT'];
  assert.deepEqual([...labels].sort((a, b) => primary.indexOf(a) - primary.indexOf(b)), labels);
  assert.ok(sources.length > 0);
  assert.ok(sources.join('').includes('FIRST PROVENANCE'));
  assert.ok(sources.join('').includes('SECOND PROVENANCE'));
});

test('detail UI reorganization preserves text and code whitespace, patch lines, JSON values and inline image data in original block order', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zS8AAAAASUVORK5CYII=';
  const text = '\t  Literal **Markdown** & <tag>\nsecond line\r\n  ';
  const code = '  const x = "<value>&";\n\treturn x;\n';
  const patch = '--- a/a.ts\n+++ b/a.ts\n-  old\n+\tnew<&>\n';
  const json = { unknownField: 'literal <&>\nline', nested: { ordered: ['first', 'second'], falseValue: false, zero: 0 } };
  const original = item({ detail: { title: '混合内容记录', blocks: [
    { kind: 'text', label: 'BLOCK TEXT', text },
    { kind: 'code', label: 'BLOCK CODE', text: code },
    { kind: 'patch', label: 'BLOCK PATCH', text: patch },
    { kind: 'json', label: 'BLOCK JSON', text: JSON.stringify(json) },
    { kind: 'image', label: 'BLOCK IMAGE', mime: 'image/png', data: png },
  ] } });
  const snapshot = JSON.stringify(original);
  const { primary } = detailRegions(renderDetail({ item: original, provider: 'codex', kept: false, nonce }));
  assert.ok(primary.includes(`<div class="plain-text">${attributeValue(text)}</div>`));
  assert.ok(primary.includes(`<pre class="code-block"><code>${attributeValue(code)}</code></pre>`));
  const patchHtml = primary.match(/<pre class="patch"[^>]*>([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(patchHtml);
  const patchLines = [...patchHtml.matchAll(/<span class="patch-line [^"]*">([\s\S]*?)<\/span>/g)].map(match => decodeHtmlText(match[1]));
  assert.equal(patchLines.join('\n'), patch);
  const prettyJson = primary.match(/<h3[^>]*>BLOCK JSON<\/h3><pre>([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(prettyJson);
  assert.deepEqual(JSON.parse(decodeHtmlText(prettyJson)), json);
  assert.ok(primary.includes(`src="data:image/png;base64,${png}"`));
  const labels = ['BLOCK TEXT', 'BLOCK CODE', 'BLOCK PATCH', 'BLOCK JSON', 'BLOCK IMAGE'];
  assert.deepEqual([...labels].sort((a, b) => primary.indexOf(a) - primary.indexOf(b)), labels);
  assert.equal(JSON.stringify(original), snapshot);
});

test('detail block label compaction preserves unknown labels including JavaScript prototype names', () => {
  const labels = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'custom-output.json', '记录中的调用参数', 'MCP 返回错误'];
  const original = item({ detail: { title: '标签核对', blocks: labels.map((label, index) => ({
    kind: 'text', label, text: `unchanged content ${index}`,
  })) } });
  const { primary } = detailRegions(renderDetail({ item: original, provider: 'codex', kept: false, nonce }));
  const headings = [...primary.matchAll(/<h3 title="([^"]*)">([\s\S]*?)<\/h3>/g)].map(match => ({ source: decodeHtmlText(match[1]), visible: decodeHtmlText(match[2]) }));
  assert.deepEqual(headings.map(heading => heading.source), labels, 'The original label remains available even for exact compact mappings');
  assert.deepEqual(headings.map(heading => heading.visible), [...labels.slice(0, 5), '调用输入', '协议错误']);
  assert.ok(!primary.includes('[native code]'));
  labels.forEach((_, index) => assert.ok(primary.includes(`unchanged content ${index}`)));
});

test('parsed Codex Web and Extension source titles and FileChange filenames never collide with compact authored labels', () => {
  const sourceLabels = ['当时命令', '当时返回'];
  const webResults = sourceLabels.map((title, index) => ({ type: 'text_result', title,
    url: `https://example.test/source-${index}`, snippet: `ORIGINAL WEB CONTENT ${index}`,
  }));
  const payloads = [
    { type: 'web_search_end', query: 'fixture source label collision', results: webResults },
    { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', query: 'fixture legacy source labels', results: webResults } },
    { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: Object.fromEntries(sourceLabels.map((path, index) => [path, {
      type: 'update', unified_diff: `--- a/${path}\n+++ b/${path}\n-old ${index}\n+new ${index}`,
    }])) } },
    { type: 'item_completed', item: { type: 'CommandExecution', command: 'fixture only', aggregated_output: 'ORIGINAL COMMAND CONTENT', exit_code: 0 } },
  ];
  const parsed = parseCodex({ file: '/fixture/detail-label-collisions.jsonl', projectPath: '/project',
    text: payloads.map(payload => JSON.stringify({ type: 'event_msg', payload })).join('\n'),
  });
  assert.equal(parsed.items.length, 4);
  const snapshot = JSON.stringify(parsed);
  for (const original of parsed.items.slice(0, 3)) {
    assert.deepEqual(original.detail?.blocks.map(block => block.label), sourceLabels);
    const header = item({ title: '按来源核对', detail: { title: '按来源核对', blocks: [] } });
    for (const html of [
      renderDetail({ item: original, provider: 'codex', kept: false, nonce }),
      renderDetail({ item: header, items: [original], provider: 'codex', kept: false, nonce }),
    ]) {
      const { primary } = detailRegions(html);
      const headings = [...primary.matchAll(/<h3 title="([^"]*)">([\s\S]*?)<\/h3>/g)].map(match => ({ source: decodeHtmlText(match[1]), visible: decodeHtmlText(match[2]) }));
      assert.deepEqual(headings, sourceLabels.map(label => ({ source: label, visible: label })));
      if (original.kind === 'file-change') {
        assert.match(primary, /patch-added/);
        assert.ok(primary.includes('+new 0'));
        assert.ok(primary.includes('+new 1'));
      } else {
        assert.equal(original.title, 'Web 来源');
        assert.ok(primary.includes('ORIGINAL WEB CONTENT 0'));
        assert.ok(primary.includes('ORIGINAL WEB CONTENT 1'));
        assert.ok(!primary.includes('<a '), 'Recorded source links remain read-only text');
      }
    }
  }
  const authored = detailRegions(renderDetail({ item: parsed.items[3], provider: 'codex', kept: false, nonce })).primary;
  assert.match(authored, /data-io="input"><h2>输入<\/h2>/);
  assert.match(authored, /data-io="output"><h2>返回<\/h2>/);
  assert.ok(authored.includes('ORIGINAL COMMAND CONTENT'));
  assert.equal(JSON.stringify(parsed), snapshot, 'Presentation does not rewrite labels or content in parsed source records');
});

test('inline image labels and captions preserve exact names that also match authored text labels', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zS8AAAAASUVORK5CYII=';
  const labels = ['当时命令', '当时返回'];
  const original = item({ detail: { title: '图像记录', blocks: labels.map(label => ({ kind: 'image', label, mime: 'image/png', data: png })) } });
  const { primary } = detailRegions(renderDetail({ item: original, provider: 'codex', kept: false, nonce }));
  labels.forEach(label => {
    assert.ok(primary.includes(`<h3 title="${label}">${label}</h3>`));
    assert.ok(primary.includes(`alt="${label}"`));
  });
  assert.equal((primary.match(/<img /g) ?? []).length, 2);
  assert.equal(primary.split(`src="data:image/png;base64,${png}"`).length - 1, 2);
});

test('selected wrapper evidence shows structured inputs and one parent output without injected scope prose', () => {
  const input = 'text(await tools.exec_command({cmd:"head -n 8 /project/first.ts"}));\ntext(await tools.exec_command({cmd:"npm test"}));';
  const output = 'FULL WRAPPER OUTPUT\nfirst file excerpt\ncombined test result';
  const records = [
    { type: 'session_meta', payload: { id: 'wrapper-scope-session', cwd: '/project' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'wrapper-turn' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'functions.exec', call_id: 'wrapper-call', arguments: input } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'wrapper-call', output } },
  ];
  const parsed = parseCodex({ file: '/fixture/detail-wrapper-scope.jsonl', projectPath: '/project', text: records.map(record => JSON.stringify(record)).join('\n') });
  const displayRow = projectedRows(parsed).find(row => row.id.startsWith('display-action-row:'));
  const legacyRow = legacyRows(parsed)[0];
  assert.ok(displayRow && legacyRow);
  const scope = '展示所选动作所在的完整调用记录；返回属于整次编排，不是该动作的独立结果。';
  for (const row of [displayRow, legacyRow]) {
    const evidence = resolveOutlineEvidence(parsed, row.id);
    assert.ok(evidence?.items);
    assert.equal(evidence.items.length, 1);
    const { primary, sources } = detailRegions(renderDetail({ ...evidence, provider: 'codex', kept: false, nonce }));
    assert.ok(!primary.includes(scope), 'Invocation hierarchy replaces injected scope explanations');
    assert.ok(!sources.some(disclosure => disclosure.includes(scope)));
    const readable = decodeHtmlText(primary.replace(/<[^>]+>/g, ''));
    assert.ok(readable.includes('head -n 8 /project/first.ts') && readable.includes('npm test'), 'Each recorded command is presented as Input');
    assert.ok(primary.includes(attributeValue(output)), 'The combined return is not split or relabelled as one atom output');
    assert.ok(primary.includes('data-io="input"') && primary.includes('data-io="output"'));
  }
  const first = readInput('independent-1');
  const second = { ...first, id: 'independent-2' };
  const independent = session([first, second]);
  const ordinaryEvidence = resolveOutlineEvidence(independent, legacyRows(independent)[0].id);
  assert.equal(ordinaryEvidence?.items?.length, 2);
  assert.ok(!renderDetail({ ...ordinaryEvidence!, provider: 'codex', kept: false, nonce }).includes(scope), 'Two independent single-action records are not one shared-output wrapper');
});

test('a raw original tool title gains a semantic detail heading while purposeful source titles and original states remain intact', () => {
  const original = item({ title: 'exec_command', detail: { title: 'exec_command', blocks: [
    { kind: 'json', label: '记录中的调用参数', text: '{"cmd":"npm test"}' },
    { kind: 'code', label: '当时返回的内容', text: 'RAW TOOL RESULT' },
  ] } });
  const raw = detailRegions(renderDetail({ item: original, provider: 'codex', kept: false, nonce }));
  const rawHeading = raw.primary.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  assert.ok(rawHeading?.includes('npm test'));
  assert.notEqual(rawHeading, 'exec_command');
  assert.ok(raw.sources.join('').includes('exec_command'));
  const purposeful = item({ ...original, detail: { ...original.detail!, title: '测试阶段输出：第一次核对' } });
  const named = detailRegions(renderDetail({ item: purposeful, provider: 'codex', kept: false, nonce }));
  assert.match(named.primary, /<h1[^>]*>测试阶段输出：第一次核对<\/h1>/);
  const failure = detailRegions(renderDetail({ item: purposeful, items: [{ ...original, status: 'failed' }], provider: 'codex', kept: false, nonce }));
  assert.match(failure.primary, /data-status="failed">失败<\/span>/, 'Single-record aggregate state comes from the original, not a stale synthetic header');
  assert.ok(!failure.primary.includes('data-status="completed"'));
  const header = raw.primary.slice(0, raw.primary.indexOf('<div class="detail-content">'));
  for (const technicalIdentity of ['session-1', 'turn-1', '/project/session.jsonl']) assert.ok(!header.includes(technicalIdentity));
  assert.match(header, /Codex/);
  assert.match(header, /已完成/);
});

test('aggregated historical patches keep each record boundary and do not imply a current workspace diff', () => {
  const first = item({ id: 'patch-first', kind: 'file-change', title: 'apply_patch', availability: 'partial', detail: {
    title: '历史修改请求', provenance: '只有输入，未确认已应用', blocks: [
      { kind: 'patch', label: '记录中的调用参数', text: '*** Begin Patch\n*** Update File: src/example.ts\n-old\n+new\n*** End Patch' },
    ],
  } });
  const second = { ...first, id: 'patch-second', status: 'unknown' as const,
    sources: [{ file: '/project/session.jsonl', line: 90, recordId: 'later-patch' }],
    detail: { ...first.detail!, provenance: '第二条仍未确认结果', notice: '只保留日志片段' } };
  const data = session([first, second]);
  const evidence = resolveOutlineEvidence(data, legacyRows(data)[0].id);
  assert.ok(evidence?.items);
  const html = renderDetail({ ...evidence, provider: 'codex', kept: true, nonce });
  assert.equal((html.match(/class="evidence-record"/g) ?? []).length, 2);
  assert.ok(!html.includes('不是当前工作区 Git diff'));
  assert.match(html, /只有输入，未确认已应用/);
  assert.match(html, /第二条仍未确认结果/);
  assert.match(html, /只保留日志片段/);
  assert.doesNotMatch(html, /状态未核实/);
  assert.match(html, /later-patch/);
  assert.match(html, /data-action="keep" disabled>已保留/);
});

test('partial historical patch carries its evidence boundary and precise sources', () => {
  const html = renderDetail({ provider: 'claude', kept: false, nonce, item: item({
    kind: 'file-change', availability: 'partial',
    detail: { title: '修改请求中的片段', provenance: '仅有调用输入，未取得成功应用结果', notice: '源输出已截断', blocks: [{
      kind: 'patch', label: '原始 patch', text: '--- a/file.ts\n+++ b/file.ts\n-old\n+new<script>bad()</script>',
    }] },
  }) });
  assert.match(html, /源输出已截断/);
  assert.ok(!html.includes('不是当前工作区 Git diff'));
  assert.match(html, /未取得成功应用结果/);
  assert.match(html, /patch-added/);
  assert.match(html, /new&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /\/project\/session\.jsonl:12/);
  assert.match(html, /记录 record-1/);
  assert.match(html, /内容块 0/);
});

test('structured questions show readonly options, answers and unrecognized source fields', () => {
  const html = renderDetail({ provider: 'claude', kept: false, nonce, item: item({ kind: 'question', detail: {
    title: '确认选项', blocks: [{ kind: 'json', label: '问题与回复', text: JSON.stringify({
      questions: [{ header: '布局', question: '详情放哪里？', options: [{ label: '右侧', description: '保留原对话' }], multiSelect: false }],
      answers: { '详情放哪里？': '右侧<script>no()</script>' }, annotations: '用户已回复', sourceVersion: 2,
    }) }],
  } }) });
  assert.match(html, /class="question-options"/);
  assert.match(html, /记录的回答/);
  assert.match(html, /右侧&lt;script&gt;no\(\)&lt;\/script&gt;/);
  assert.match(html, /sourceVersion/);
  assert.ok(!html.includes('请在原 Agent 对话中作答'));
  assert.ok(!detailRegions(html).primary.includes('请在原 Agent 对话中作答'));
  assert.ok(!html.includes('<input'));
  assert.ok(!html.includes('<form'));
});

test('image rendering allows base64 raster data only, never SVG or remote URLs', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zS8AAAAASUVORK5CYII=';
  const html = renderDetail({ provider: 'codex', kept: false, nonce, item: item({ detail: { title: '图像', blocks: [
    { kind: 'image', label: '记录截图', mime: 'image/png', data: png },
    { kind: 'image', label: '不受支持的矢量图', mime: 'image/svg+xml', data: 'PHN2Zy8+' },
    { kind: 'image', label: '外链', mime: 'image/png', data: 'https://example.com/image.png' },
    { kind: 'image', label: '属性注入', mime: 'image/png', data: 'abcd" onerror="evil()' },
  ] } }) });
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.ok(!html.includes('https://example.com'));
  assert.ok(!html.includes('onerror='));
  assert.match(html, /图像不可用/);
});

test('keep uses the narrow message action and is disabled for already kept evidence', () => {
  assert.match(renderDetail({ item: item(), provider: 'codex', kept: false, nonce }), /data-action="keep">保留此页/);
  assert.match(renderDetail({ item: item(), provider: 'codex', kept: true, nonce }), /data-action="keep" disabled>已保留/);
});

test('webview script parses, preserves per-session scroll and focus, and sends no layout messages', () => {
  const html = renderSidecar({ projectName: 'project', session: session([item()]), nonce });
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /getState\(\)/);
  assert.match(source, /previous\.sessionId === sessionId/);
  assert.match(source, /setState\(/);
  assert.match(source, /selectedTurnId/);
  assert.match(source, /readingVersion: 3/);
  assert.match(source, /preventScroll: true/);
  assert.equal((source.match(/type: 'viewport'/g) ?? []).length, 0, 'A sidebar view has no editor width to calibrate');
  assert.ok(!source.includes('fetch('));
  assert.ok(!source.includes('window.open'));
});

test('toolbar refresh remembers the actual control instead of restoring the previous timeline button', () => {
  const before = scriptFixture({ state: { sessionId: 'codex:session-1', readingVersion: 3, selectedId: 'tool-1', focusId: 'tool-1', scrollTop: 220 } });
  before.focus(before.refresh);
  before.click(before.refresh);
  assert.equal(before.state?.focusAction, 'refresh');
  assert.equal(before.state?.focusId, '');
  assert.equal(before.state?.selectedId, 'tool-1');
  assert.deepEqual(before.sent.at(-1), { type: 'refresh' });
  const refreshed = scriptFixture({ state: before.state });
  assert.deepEqual(refreshed.focused, [{ dataset: { action: 'refresh' }, preventScroll: true }]);
  assert.equal(refreshed.timeline.scrollTop, 220);
  refreshed.focus(refreshed.node);
  const nodeRefresh = scriptFixture({ state: refreshed.state });
  assert.deepEqual(nodeRefresh.focused, [{ dataset: { itemId: 'tool-1' }, preventScroll: true }]);
});

test('refresh restoration does not focus any control when the webview is not focused', () => {
  for (const target of [
    { focusAction: 'refresh', focusId: '' },
    { focusAction: '', focusId: 'tool-1' },
    { focusTurnId: 'turn:turn-2' },
    { focusGroupId: 'background:turn:turn-2' },
  ]) {
    const fixture = scriptFixture({ focused: false, state: { sessionId: 'codex:session-1', readingVersion: 3, ...target, scrollTop: 220 } });
    assert.deepEqual(fixture.focused, []);
    assert.equal(fixture.timeline.scrollTop, 220);
    assert.deepEqual([...fixture.windowHandlers.keys()].sort(), ['message'], 'No global focus or resize watcher is installed');
  }
});

test('refresh restores the turn the reader was on, and the control they had focused in it', () => {
  const fixture = scriptFixture({ state: {
    sessionId: 'codex:session-1', selectedTurnId: 'turn:turn-1', focusId: 'tool-previous', readingVersion: 3, scrollTop: 40,
    expandedActionIds: [],
  } });
  // One turn to a page, the older one the reader was on; the newest is in the page, not shown.
  assert.deepEqual(fixture.panels.map(panel => panel.hasAttribute('data-current')), [false, true]);
  assert.deepEqual(fixture.focused, [{ dataset: { itemId: 'tool-previous' }, preventScroll: true }]);
  assert.equal(fixture.timeline.scrollTop, 40);
});

test('refresh cannot focus an attached context button inside a collapsed background', () => {
  const fixture = scriptFixture({ state: {
    sessionId: 'codex:session-1', selectedTurnId: 'turn:turn-2', focusId: 'context-1',
    expandedActionIds: [], readingVersion: 3, scrollTop: 220,
  } });
  assert.equal(fixture.panels[1].hidden, false);
  assert.equal(fixture.backgrounds[1].open, false);
  assert.deepEqual(fixture.focused, []);
  assert.equal(fixture.timeline.scrollTop, 220);
  const summary = scriptFixture({ state: {
    sessionId: 'codex:session-1', selectedTurnId: 'turn:turn-2', focusGroupId: 'background:turn:turn-2', expandedActionIds: [],
  } });
  assert.deepEqual(summary.focused, [{ dataset: { actionGroup: 'background:turn:turn-2' }, preventScroll: true }],
    'A collapsed group summary itself remains visible and focusable');
});

test('Keep is confirmed in place only by the narrow host message, without scrolling or focusing', () => {
  const fixture = scriptFixture({ detail: true });
  fixture.click(fixture.keep);
  assert.deepEqual(fixture.sent, [{ type: 'keep' }]);
  assert.equal(fixture.keep.disabled, false, 'Wait for the host confirmation');
  for (const message of [null, 'kept', { type: 'executeCommand', command: 'danger' }, { type: 'kept', command: 'danger' }, ['kept']]) fixture.message(message);
  assert.equal(fixture.keep.disabled, false);
  fixture.message({ type: 'kept' });
  assert.equal(fixture.keep.disabled, true);
  assert.equal(fixture.keep.textContent, '已保留');
  assert.equal(fixture.status.textContent, '已保留');
  assert.equal(fixture.document.scrollingElement.scrollTop, 880);
  assert.deepEqual(fixture.focused, []);
  fixture.click(fixture.keep);
  fixture.click(fixture.unknownButton());
  assert.deepEqual(fixture.sent, [{ type: 'keep' }], 'Neither a disabled button nor an unknown action emits a command');
});

test('a thinking summary and the words right after it head one chapter; a call between them starts the next', () => {
  const said = (id: string, text: string) => item({ id, kind: 'message', title: '过程说明', summary: text, availability: 'none', detail: undefined });
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'q', kind: 'request', title: '用户请求', summary: '改一下', availability: 'none', detail: undefined }),
    said('think', '先看解析器。'), said('say', '我先读 claude.ts。'), readInput('read-a'), said('next', '接下来改视图。'), readInput('read-b')]) });
  const chapters = html.split('<li class="chapter').slice(1);
  assert.equal(chapters.length, 2);
  assert.equal((chapters[0].match(/class="csay"/g) ?? []).length, 2);
  assert.ok(chapters[0].indexOf('先看解析器') < chapters[0].indexOf('我先读 claude.ts') && chapters[0].includes('data-observation-key="say:say"'));
  assert.equal((chapters[1].match(/class="csay"/g) ?? []).length, 1);
});

test('only the newest open turn carries live markers: a call still out, or the agent holding the turn', () => {
  const at = '2026-09-23T06:24:07.000Z';
  const request = (id: string, turnId: string) => item({ id, turnId, kind: 'request', title: '用户请求', summary: id, availability: 'none', detail: undefined, timestamp: at });
  const said = (id: string, turnId: string) => item({ id, turnId, kind: 'message', title: '过程说明', summary: id, availability: 'none', detail: undefined, timestamp: at });
  const pending = readInput('read-out', { turnId: 't2', timestamp: at, status: 'unknown' });
  let html = renderSidecar({ projectName: 'project', nonce, session: session([request('q1', 't1'), said('s1', 't1'), request('q2', 't2'), said('s2', 't2'), pending]) });
  // From this turn's panel to the next one: turns never nest.
  const panel = (key: string) => html.slice(html.indexOf(`data-turn-panel="turn:${key}"`)).split(/<section class="turn-panel|<\/main>/)[0];
  assert.match(panel('t2'), /data-last-at="2026-09-23T06:24:07.000Z"/);
  // A call still out is drawn as any other, its state said only to the screen reader; the one spinner is at the end, shown even while a call runs.
  assert.match(panel('t2'), /<button type="button" class="crow node-button"[^>]* title="Read · read-out\.ts · 进行中[^"]*"><span class="cbranch" aria-hidden="true"><\/span>/);
  assert.equal(panel('t2').match(/class="cspin"/g)?.length, 1);
  assert.match(panel('t2'), /<li class="cseg tend live-tail"[^>]*><span class="cbranch"><span class="cspin"><\/span><\/span>/);
  assert.doesNotMatch(html, /:has\(\.crow\[data-out\]/);
  assert.ok(!panel('t1').includes('data-last-at') && !panel('t1').includes('live-tail'), 'An older turn is never live');
  html = renderSidecar({ projectName: 'project', nonce, session: session([request('q2', 't2'), said('s2', 't2'),
    item({ id: 'end', turnId: 't2', kind: 'notice', title: '回合结束', summary: '', status: 'completed', availability: 'none', detail: undefined, timestamp: at })]) });
  assert.ok(!panel('t2').includes('data-last-at') && !panel('t2').includes('live-tail'), 'The source closed the turn');
});

test('pasted content is set apart without its transport tags, in the request and the lens', () => {
  const text = '看下这些点：\n\n<pasted_content id="e353">\n1. 中间的对话丢了\n2. 附带背景是啥\n</pasted_content id="e353">\n\n给修复方案';
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'q', kind: 'request', title: '用户请求', summary: text.slice(0, 30) + '…', detail: { title: '用户请求', blocks: [{ kind: 'text', label: '用户请求', text }] } }),
    item({ id: 's', kind: 'message', title: '过程说明', summary: '好的', availability: 'none', detail: undefined })]) });
  assert.ok(!html.includes('pasted_content'));
  const question = html.slice(html.indexOf('class="turn-question"')).split('</section>')[0];
  assert.match(question, /<div class="pasted"><div class="pasted-label">粘贴的内容 · 2 行<\/div><div class="markdown"><ol>/);
  assert.ok(question.indexOf('看下这些点') < question.indexOf('class="pasted"') && question.indexOf('class="pasted"') < question.indexOf('给修复方案'));
});

test('a request with images always offers 展开全文, which opens it with its images', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'q', kind: 'request', title: '用户请求', summary: '看图', detail: { title: '用户请求', blocks: [{ kind: 'image', label: '记录中的图像', mime: 'image/png', data: png }] } })]) });
  assert.match(html, /class="question-more" data-item-id="q" data-open-text data-always aria-pressed="false">展开全文<\/button>/, 'One label; images open with the full request');
  assert.ok(!html.includes('<figure'), 'Images open at full size in the detail page, not shrunk in the card');
});

test('a background task notification is a row in the turn; the turn header carries no failure count', () => {
  const note = (id: string, title: string, status: TimelineItem['status'], exitCode?: number) => item({ id, kind: 'notice', noticeType: 'task-notification', taskTool: 'Bash',
    title, summary: `Background command "${title}" ${status === 'failed' ? `failed with exit code ${exitCode}` : 'completed (exit code 0)'}`, status, ...(exitCode !== undefined ? { exitCode } : {}),
    detail: { title, blocks: [{ kind: 'text', label: '后台任务通知', text: title }] } });
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'q', kind: 'request', title: '用户请求', summary: '跑测试', availability: 'none', detail: undefined }),
    note('ok', 'Run real VS Code host tests', 'completed'), note('bad', 'Render replay page', 'failed', 144)]) });
  const rows = actionHtmlRows(html);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /data-tool="Bash"[\s\S]*Run real VS Code host tests<\/span><span class="cnote">done<\/span>/);
  assert.match(rows[1], /Render replay page<\/span><span class="cbad"[^>]*>exit 144<\/span>/);
  assert.ok(!html.includes('子任务通知') && !html.includes('项失败'));
});

test('a read of one file opens as that file: its recorded lines, numbered where the source says, highlighted by type', () => {
  const read = (id: string, input: unknown, output: string, title = 'Bash') => item({ id, title, result: 'readable', detail: { title, blocks: [
    { kind: 'json', label: '当时调用参数', text: JSON.stringify(input) }, { kind: 'text', label: '当时返回', text: output }] } });
  const detail = (record: TimelineItem) => renderDetail({ item: record, provider: 'claude', kept: false, nonce });
  let html = detail(read('sed', { command: 'cd /repo && sed -n 196,198p packages/core/src/claude.ts' }, 'const a = 1;\nconst b = 2;\nconst c = 3;\n'));
  assert.match(html, /<h1>claude\.ts<\/h1>/);
  assert.match(html, /<span class="file-path">\/repo\/packages\/core\/src\/claude\.ts<\/span><span>第 196–198 行<\/span>/);
  assert.match(html, /<pre class="line-numbers" aria-hidden="true">196\n197\n198<\/pre><pre class="source-code"><code class="language-typescript"><span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<details class="sources" data-evidence-source>[\s\S]*cd \/repo &amp;&amp; sed -n 196,198p/, 'The command stays in the folded sources');
  html = detail(read('native', { file_path: '/repo/README.md', offset: 10, limit: 2 }, '10\t# Title\n11\tbody', 'Read'));
  assert.match(html, /<pre class="line-numbers" aria-hidden="true">10\n11<\/pre><pre class="source-code"><code class="language-markdown">/);
  assert.ok(!html.includes('10\t'), 'The reader\'s own numbers move into the gutter');
  html = detail(read('tail', { command: 'tail -n 2 log.txt' }, 'x\ny'));
  assert.match(html, /class="code-surface no-gutter"/, 'tail does not say where it starts');
  for (const command of ['cat a.ts b.ts', 'cat a.ts | head', 'npm test']) assert.ok(!detail(read('x', { command }, 'out')).includes('class="code-surface'), command);
  assert.ok(!detail({ ...read('failed', { command: 'cat missing.ts' }, 'No such file'), status: 'failed' }).includes('class="code-surface'));
});

test('a turn that is over keeps its process open, the answer folded at its end; a running turn ends in a spinner', () => {
  const said = (id: string, turnId: string) => item({ id, turnId, kind: 'message', title: '过程说明', summary: id, availability: 'none', detail: undefined });
  const bash = (id: string, turnId: string) => item({ id, turnId, title: 'Bash', detail: { title: 'Bash', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ command: `npm run ${id}` }) }] } });
  const html = renderSidecar({ projectName: 'project', nonce, session: session([
    item({ id: 'q', turnId: 't1', kind: 'request', title: '用户请求', summary: '改一下', availability: 'none', detail: undefined, timestamp: '2026-09-23T06:00:00.000Z' }),
    said('long', 't1'), bash('a', 't1'), readInput('r1', { turnId: 't1' }), said('short', 't1'), bash('c', 't1'),
    item({ id: 'done', turnId: 't1', kind: 'answer', title: '历史回答', summary: '改好了。', availability: 'none', detail: undefined, timestamp: '2026-09-23T06:03:12.000Z' })]) });
  const panel = html.slice(html.indexOf('data-turn-panel="turn:t1"')).split(/<section class="turn-panel|<\/main>/)[0];
  // The reader is here for the process: nothing folds it away. The calls hang from their tool's name on a tree.
  assert.ok(!panel.includes('cprocess'));
  assert.equal((panel.match(/class="csay"/g) ?? []).length, 3, 'The agent\'s words, and the answer\'s');
  assert.deepEqual([...panel.matchAll(/<div class="ctool">([^<]+)<\/div>/g)].map(match => match[1]), ['Bash', 'Read', 'Bash']);
  assert.ok(panel.indexOf('class="tlabel">Prompt') < panel.indexOf('class="ccalls"') && panel.indexOf('class="ccalls"') < panel.indexOf('Final Answer'), 'Prompt above, the answer at the end');
  const at = '2026-09-23T06:24:07.000Z';
  const running = renderSidecar({ projectName: 'project', nonce, session: session([said('newest', 't2'), ...['d', 'e', 'f'].map(id => ({ ...bash(id, 't2'), timestamp: at }))]) });
  const live = running.slice(running.indexOf('data-turn-panel="turn:t2"')).split('</main>')[0];
  assert.ok(!live.includes('Final Answer') && live.includes('class="cseg tend live-tail"'), 'A running turn has no answer yet; its end turns');
});

test('the loading word is the agent\'s own: one of Claude Code\'s verbs per turn, Working for Codex', async () => {
  const { statusVerb } = await import('../packages/core/src/verbs');
  assert.equal(statusVerb('codex', 'turn:a'), 'Working');
  const verb = statusVerb('claude', 'turn:a');
  assert.match(verb, /^[A-Z][\w'-]+ing'?…$|^Flambéing…$|^Sautéing…$|^Beboppin'…$/);
  assert.equal(statusVerb('claude', 'turn:a'), verb, 'Stable for a turn');
  assert.ok(new Set(['turn:a', 'turn:b', 'turn:c', 'turn:d', 'turn:e'].map(key => statusVerb('claude', key))).size > 1, 'Varies across turns');
});

test('a question to the user sits in its place among the calls and shows what was chosen', () => {
  const ask = item({ id: 'ask', kind: 'question', title: 'AskUserQuestion', detail: { title: 'AskUserQuestion', blocks: [
    { kind: 'json', label: '当时调用参数', text: JSON.stringify({ questions: [{ question: '仓库设为？', header: '可见性', options: [{ label: '私有 (Recommended)' }, { label: '公开' }] }] }) },
    { kind: 'json', label: '问题及记录的回答', text: JSON.stringify({ questions: [], answers: { '仓库设为？': '私有 (Recommended)' } }) }] } });
  const bash = (id: string) => item({ id, title: 'Bash', detail: { title: 'Bash', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ command: `echo ${id}`, description: `Step ${id}` }) }] } });
  const html = renderSidecar({ projectName: 'project', nonce, session: session([bash('before'), ask, bash('after')]) });
  const rows = actionHtmlRows(html);
  assert.deepEqual(rows.map(row => /data-tool="([^"]+)"/.exec(row)![1]), ['Bash', 'Ask', 'Bash'], 'In source order, not after the calls around it');
  const asked = /<li class="crow-item"[^>]*><button[^>]*data-tool="Ask"[\s\S]*?<\/li>/.exec(html)![0];
  assert.match(asked, /仓库设为？<\/span><\/button><div class="cchoices"><b class="cchoice">✓ 私有 \(Recommended\)<\/b><\/div>/, 'Only what was chosen, under it on the tree');
  assert.ok(!asked.includes('公开'), 'An option not chosen is not shown as if it were an answer');
});

test('an image placeholder in a request stays as the text the user sent', () => {
  const html = renderSidecar({ projectName: 'project', nonce, session: session([item({ id: 'q', kind: 'request', title: '用户请求', summary: '这里没对齐 [Image #10] 看一下', availability: 'none', detail: undefined })]) });
  assert.match(html.slice(html.indexOf('class="turn-question"')), /<p>这里没对齐 \[Image #10\] 看一下<\/p>/);
});

