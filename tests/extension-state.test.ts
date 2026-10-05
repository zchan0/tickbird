import { strict as assert } from 'node:assert';
import Module from 'node:module';
import { test } from 'node:test';
import type { SessionCandidate, SessionData } from '../packages/core/src/model';
import type { SessionPickerEntry, SessionPickerMetadata } from '../packages/core/src/session-picker';
import type { LiveUpdate, ObservationHealth } from '../packages/core/src/live-session';
import { actionRows, actionRowSections, outlineTurn } from '../packages/core/src/outline';
import { groupSessionTurns } from '../packages/core/src/timeline';
import * as sessionStateModule from '../packages/core/src/session-state';
import type { SessionState } from '../packages/core/src/session-state';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This is an in-memory async/control-flow fixture, not a real VS Code host test.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class FixtureEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) { for (const listener of this.listeners) listener(value); }
  get listenerCount() { return this.listeners.size; }
  dispose() { this.listeners.clear(); }
}
const a: SessionCandidate = { id: 'a', provider: 'codex', file: '/fixture/a.jsonl', projectPath: '/fixture', updatedAt: 0, activity: 'unverified' };
const b: SessionCandidate = { ...a, id: 'b', provider: 'claude', file: '/fixture/b.jsonl' };
function data(candidate: SessionCandidate): SessionData {
  return { id: candidate.id, provider: candidate.provider, projectPath: '/fixture', title: candidate.id,
    warnings: [], coverage: [], items: [{ id: `${candidate.id}:tool`, sessionId: candidate.id, kind: 'tool', title: '测试',
      summary: '测试输出', status: 'completed', availability: 'available', sources: [{ file: candidate.file, line: 2 }],
      detail: { title: '测试记录', blocks: [{ kind: 'code', label: '返回', text: 'PASS' }] } }] };
}
function aggregateData(candidate: SessionCandidate): SessionData {
  const snapshot = data(candidate);
  const original = snapshot.items[0];
  const calls = [0, 1].map(index => ({ ...original, id: `${candidate.id}:read-${index}`, turnId: 'turn-1', title: 'Read',
    sources: [{ file: candidate.file, line: index + 3 }],
    detail: { title: '当时读取', provenance: `来源范围 ${index}`, blocks: [
      { kind: 'json' as const, label: '当时调用参数', text: JSON.stringify({ file_path: '/fixture/read.ts' }) },
      { kind: 'text' as const, label: '当时返回', text: `独立输出 ${index}` },
    ] },
  }));
  return { ...snapshot, items: [{ ...original, turnId: 'turn-1' }, ...calls] };
}
function rows(snapshot: SessionData) {
  return groupSessionTurns(snapshot).flatMap(turn => outlineTurn(turn).nodes.flatMap(node => node.kind === 'actions' ? actionRows(node) : []));
}

function harness(initialOrientation = 0) {
  type Layout = { orientation: number; groups: Array<{ size?: number; groups?: unknown[]; tabs?: Array<{ label?: string; input?: unknown }> }> };
  let layout: Layout = { orientation: initialOrientation, groups: [{}] };
  let activeColumn = 1;
  let revealCalls = 0;
  let focusCommands = 0;
  const layoutWrites: number[] = [];
  let layoutReads = 0;
  let layoutGate: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  let focusGate: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  const commands = new Map<string, () => Promise<void>>();
  const state = new Map<string, unknown>();
  const documents = new Map<string, { text: string }>();
  let provider: { provideTextDocumentContent(uri: { toString(): string }): string; onDidChange: FixtureEmitter<unknown>['event'] };
  const warnings: string[] = [];
  const executed: string[] = [];
  let discoveries = 0;
  const metadataEntry = (candidate: SessionCandidate, ready = false): SessionPickerEntry => ({
    key: `${candidate.provider}:${candidate.id}`, title: ready ? `会话标题 ${candidate.id}` : `${candidate.provider} · ${candidate.id}`,
    shortId: candidate.id.slice(0, 8),
    providerLabel: candidate.provider === 'codex' ? 'Codex' : 'Claude Code', updatedAt: candidate.updatedAt,
    updatedLabel: '日志更新 2026/9/7 10:00:00', metadataStatus: ready ? 'ready' : 'deferred',
    ...(ready ? { latestRole: 'assistant', latestText: `Agent：最近公开内容 ${candidate.id}` } : { reason: '选中后读取名称与最近对话' }),
  });
  const metadata: SessionPickerMetadata = {
    base: candidate => metadataEntry(candidate),
    read: async candidate => metadataEntry(candidate, true),
    list: async candidates => candidates.map(candidate => metadataEntry(candidate, true)),
  };
  type Choice = { key: string; label: string; description?: string; detail?: string };
  class FixtureQuickPick {
    title = ''; placeholder = ''; matchOnDescription = false; matchOnDetail = false;
    shown = false; disposed = false; itemsWrites = 0; busyWrites = 0; disposeCalls = 0;
    private choices: Choice[] = [];
    private active: Choice[] = [];
    private loading = false;
    selectedItems: Choice[] = [];
    readonly acceptEvent = new FixtureEmitter<void>();
    readonly hideEvent = new FixtureEmitter<void>();
    readonly activeEvent = new FixtureEmitter<Choice[]>();
    onDidAccept = this.acceptEvent.event;
    onDidHide = this.hideEvent.event;
    onDidChangeActive = this.activeEvent.event;
    get items() { return this.choices; }
    set items(value: Choice[]) { this.choices = value; this.itemsWrites++; }
    get activeItems() { return this.active; }
    set activeItems(value: Choice[]) {
      const changed = value.map(item => item.key).join('|') !== this.active.map(item => item.key).join('|');
      this.active = value;
      if (changed) this.activeEvent.fire(value);
    }
    get busy() { return this.loading; }
    set busy(value: boolean) { this.loading = value; this.busyWrites++; }
    show() { this.shown = true; }
    hide() { if (this.shown) { this.shown = false; this.hideEvent.fire(); } }
    dispose() {
      if (this.disposed) return;
      this.disposed = true; this.shown = false; this.disposeCalls++;
      this.acceptEvent.dispose(); this.hideEvent.dispose(); this.activeEvent.dispose();
    }
    activate(key: string) { this.activeItems = this.items.filter(item => item.key === key); }
    accept(key: string) { this.selectedItems = this.items.filter(item => item.key === key); this.acceptEvent.fire(); }
    get listenerCount() { return this.acceptEvent.listenerCount + this.hideEvent.listenerCount + this.activeEvent.listenerCount; }
  }
  const pickers: FixtureQuickPick[] = [];
  const sources = {
    discover: async () => ({ candidates: [a, b], warnings: [] as string[] }),
    load: async (candidate: SessionCandidate) => data(candidate),
  };
  const lives: Array<{ session: SessionData; health: ObservationHealth; closed: boolean; listener?: (update: LiveUpdate) => void; emit(): void }> = [];
  const workspaceChange = new FixtureEmitter<void>();
  const panels: Array<{ receive: FixtureEmitter<unknown>; viewColumn: number; disposed: boolean; viewType: string }> = [];
  let viewProvider: { resolveWebviewView(view: unknown): Promise<void> } | undefined;
  let sidebar: any;
  // The Sidecar is a sidebar view: column 0 here only marks "not an editor group".
  const createSidebarView = () => {
    const receive = new FixtureEmitter<unknown>();
    const dispose = new FixtureEmitter<void>();
    const visibility = new FixtureEmitter<void>();
    let html = '', htmlWrites = 0;
    const messages: unknown[] = [];
    const view = { receive, viewType: 'agentSidecar.observer', viewColumn: 0, disposed: false, visible: true, showCalls: 0,
      webview: {
        get html() { return html; }, set html(value: string) { html = value; ++htmlWrites; },
        get htmlWrites() { return htmlWrites; }, messages,
        options: {}, onDidReceiveMessage: receive.event,
        postMessage: async (message: unknown) => { messages.push(message); return true; },
      },
      onDidDispose: dispose.event, onDidChangeVisibility: visibility.event,
      show() { view.showCalls++; },
      hide() { view.visible = false; visibility.fire(); }, reveal() { view.visible = true; visibility.fire(); },
      dispose() { view.disposed = true; dispose.fire(); } };
    panels.unshift(view);
    return view;
  };
  const vscode = {
    ExtensionMode: { Test: 3 }, ViewColumn: { Active: -1, One: 1, Three: 3 }, EventEmitter: FixtureEmitter,
    Disposable: class {
      private callback: (() => void) | undefined;
      constructor(callback: () => void) { this.callback = callback; }
      dispose() { const callback = this.callback; this.callback = undefined; callback?.(); }
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    workspace: {
      onDidChangeWorkspaceFolders: workspaceChange.event,
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/fixture' } }],
      registerTextDocumentContentProvider: (_scheme: string, value: typeof provider) => {
        provider = value;
        return provider.onDidChange((uri: any) => {
          const doc = documents.get(uri.toString());
          if (doc) doc.text = provider.provideTextDocumentContent(uri);
        });
      },
      openTextDocument: async (uri: { toString(): string }) => {
        if (!documents.has(uri.toString())) documents.set(uri.toString(), { text: provider.provideTextDocumentContent(uri) });
        return documents.get(uri.toString());
      },
    },
    window: {
      createQuickPick: () => { const picker = new FixtureQuickPick(); pickers.push(picker); return picker; },
      tabGroups: { get all() { return layout.groups.map((group, index) => {
        const owned = panels.filter(panel => !panel.disposed && panel.viewColumn === index + 1).map(panel => ({ input: { viewType: panel.viewType } }));
        return { ...group, viewColumn: index + 1, tabs: group.tabs ?? (owned.length ? owned : index === 1 ? [{ label: 'Agent fixture', input: { viewType: 'fixture-agent' } }] : []) };
      }); } },
      showWarningMessage: async (value: string) => { warnings.push(value); },
      showTextDocument: async () => undefined,
      registerWebviewViewProvider: (_id: string, value: typeof viewProvider) => { viewProvider = value; return { dispose() {} }; },
      createWebviewPanel: (_type: string, title: string, column: number | { viewColumn: number; preserveFocus?: boolean }) => {
        const receive = new FixtureEmitter<unknown>();
        const dispose = new FixtureEmitter<void>();
        let html = '';
        let htmlWrites = 0;
        const messages: unknown[] = [];
        const panel = { receive, title, viewType: _type, disposed: false, viewColumn: typeof column === 'number' ? column : column.viewColumn,
          get active() { return activeColumn === this.viewColumn; },
          webview: {
            get html() { return html; }, set html(value: string) { html = value; ++htmlWrites; },
            get htmlWrites() { return htmlWrites; }, messages,
            options: {}, onDidReceiveMessage: receive.event,
            postMessage: async (message: unknown) => { messages.push(message); return true; },
          },
          onDidDispose: dispose.event, onDidChangeViewState: new FixtureEmitter<void>().event,
          reveal(nextColumn?: number, preserveFocus = false) {
            ++revealCalls;
            if (nextColumn !== undefined) this.viewColumn = nextColumn;
            if (!preserveFocus) activeColumn = this.viewColumn;
          }, dispose: () => { panel.disposed = true; dispose.fire(); } };
        if (typeof column === 'number' || !column.preserveFocus) activeColumn = panel.viewColumn;
        panels.push(panel);
        return panel;
      },
    },
    commands: {
      registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return { dispose() {} }; },
      executeCommand: async (name: string, value?: Layout) => {
        executed.push(name);
        if (name === 'agentSidecar.observer.focus') {
          if (!sidebar || sidebar.disposed) { sidebar = createSidebarView(); void viewProvider!.resolveWebviewView(sidebar); }
          return undefined;
        }
        if (name === 'workbench.action.focusFirstEditorGroup') {
          ++focusCommands;
          const gate = focusGate;
          focusGate = undefined;
          if (gate) { gate.started.resolve(); await gate.release.promise; }
          activeColumn = 1;
        }
        if (name === 'vscode.getEditorLayout') {
          ++layoutReads;
          const snapshot = structuredClone(layout);
          const gate = layoutGate;
          layoutGate = undefined;
          if (gate) { gate.started.resolve(); await gate.release.promise; }
          return snapshot;
        }
        if (name === 'workbench.action.newGroupLeft') layout.groups.unshift({});
        if (name === 'vscode.setEditorLayout' && value) {
          layout = value;
          layoutWrites.push(value.groups.length);
          // Reproduce the public-host observation with real Agent custom editors:
          // changing the editor layout may activate the middle Agent group.
          activeColumn = value.groups.length > 1 ? 2 : 1;
        }
        return undefined;
      },
    },
  };
  const globals = new Map<string, unknown>();
  // What the integration hooks would have written; tests set it directly.
  const sessionStates: { list: SessionState[] } = { list: [] };
  const context = { extensionMode: 3, subscriptions: [] as Array<{ dispose(): unknown }>,
    workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
    globalState: { get: (key: string) => globals.get(key), update: async (key: string, value: unknown) => { globals.set(key, value); } } };
  const loader = Module as unknown as { _load(request: string, ...args: unknown[]): unknown };
  const original = loader._load;
  const entry = require.resolve('../packages/vscode/src/extension');
  delete require.cache[entry];
  loader._load = function (request, ...args) {
    if (request === 'vscode') return vscode;
    if (request === 'node:fs/promises') return { realpath: async (path: string) => path };
    if (request === '../../core/src/live-session') return { openLiveSession: async (candidate: SessionCandidate) => {
      const session = await sources.load(candidate);
      const live = { session, health: { state: 'observing' as const, pendingBytes: 0, readBytes: 10 }, closed: false,
        listener: undefined as ((update: LiveUpdate) => void) | undefined,
        start(listener: (update: LiveUpdate) => void) { this.listener = listener; },
        emit() { this.listener?.({ session, health: this.health, contentChanged: true }); },
        async poll() {}, async close() { this.closed = true; } };
      lives.push(live); return live;
    } };
    if (request === '../../core/src/sessions') return {
      discoverSessions: () => { ++discoveries; return sources.discover(); }, loadSession: (candidate: SessionCandidate) => sources.load(candidate),
      sessionKey: (candidate: SessionCandidate) => `${candidate.provider}:${candidate.id}`,
    };
    if (request === '../../core/src/session-picker') return { createSessionPickerMetadata: () => metadata };
    if (request === '../../core/src/session-state') return { ...sessionStateModule,
      sessionStateDirectory: () => join(tmpdir(), 'sidecar-no-state-dir'), readSessionStates: async () => sessionStates.list.map(item => ({ ...item })) };
    return original.call(this, request, ...args);
  };
  let api: ReturnType<typeof import('../packages/vscode/src/extension').activate>;
  try { api = require(entry).activate(context); }
  finally { loader._load = original; delete require.cache[entry]; }
  return { api, sources, state, documents, warnings, layoutWrites, metadata, metadataEntry, pickers, lives, sessionStates, globals,
    changeWorkspace(folders: Array<{ uri: { scheme: string; fsPath: string } }> = []) { vscode.workspace.workspaceFolders = folders; workspaceChange.fire(); },
    setFolders(folders: Array<{ uri: { scheme: string; fsPath: string } }>) { vscode.workspace.workspaceFolders = folders; },
    executed, get discoveries() { return discoveries; },
    get groupCount() { return layout.groups.length; }, get layoutReads() { return layoutReads; },
    get activeColumn() { return activeColumn; }, get revealCalls() { return revealCalls; }, get focusCommands() { return focusCommands; },
    focusColumn: (column: number) => { activeColumn = column; },
    setLayout: (value: Layout) => { layout = structuredClone(value); activeColumn = Math.min(activeColumn, value.groups.length); },
    receive: (message: unknown) => sidebar.receive.fire(message),
    get sidebar() { return sidebar; },
    command: (name: string) => commands.get(name)!(),
    blockLayoutRead() {
      const gate = { started: deferred<void>(), release: deferred<void>() };
      layoutGate = gate;
      return gate;
    },
    blockFocusCommand() {
      const gate = { started: deferred<void>(), release: deferred<void>() };
      focusGate = gate;
      return gate;
    },
    async ready() { await api.openObserver(); await api.scan(); await api.selectSession('codex:a'); },
    dispose() { for (const subscription of context.subscriptions) subscription.dispose(); },
  };
}

test('live records use postMessage without resetting HTML, layout, focus or evidence snapshots', async () => {
  const host = harness();
  try {
    await host.ready(); await host.api.openDetail('a:tool');
    const observer = host.api.observer as unknown as { webview: { htmlWrites: number; messages: unknown[] } }, preview = host.api.preview!;
    const writes = observer.webview.htmlWrites, evidenceHtml = preview.panel.webview.html;
    const layouts = host.layoutWrites.length, focus = host.focusCommands;
    host.lives[0].session.items[0].detail!.blocks.push({ kind: 'text', label: '返回', text: 'LATE OUTPUT' });
    host.lives[0].emit(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(observer.webview.htmlWrites, writes);
    assert.equal(host.layoutWrites.length, layouts); assert.equal(host.focusCommands, focus);
    assert.equal(preview.panel.webview.html, evidenceHtml); assert.ok(!JSON.stringify(preview.item).includes('LATE OUTPUT'));
    const message = observer.webview.messages.at(-1) as any;
    assert.equal(message.type, 'observation'); assert.equal(message.sessionId, 'codex:a');
    host.receive({ type: 'observerReady', streamId: message.streamId }); await new Promise(resolve => setImmediate(resolve));
    assert.equal((observer.webview.messages.at(-1) as any).reset, true);
  } finally { host.dispose(); }
});

test('selection, disposal and workspace changes cancel live delivery without auto binding', async () => {
  const host = harness();
  try {
    await host.ready(); const old = host.lives[0]; await host.api.selectSession('claude:b');
    assert.equal(old.closed, true);
    const observer = host.api.observer as unknown as { webview: { messages: unknown[] } }, count = observer.webview.messages.length;
    old.emit(); await new Promise(resolve => setImmediate(resolve)); assert.equal(observer.webview.messages.length, count);
    host.changeWorkspace(); assert.equal(host.lives[1].closed, true);
    const messages = observer.webview.messages.length;
    host.lives[1].emit(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(observer.webview.messages.length, messages, 'A closed source posts nothing');
    // The window lost its only folder: the view explains that instead of keeping a stopped session.
    assert.match((observer as any).webview.html, /data-workspace-gap="empty"/);
    assert.equal(host.api.session?.id, 'b');
    assert.deepEqual(host.warnings, []);
  } finally { host.dispose(); }
});

test('a folder switched without a reload stops the old source and asks for a new selection', async () => {
  const host = harness();
  try {
    await host.ready();
    const observer = host.api.observer as unknown as { webview: { messages: unknown[]; htmlWrites: number } }, writes = observer.webview.htmlWrites;
    host.changeWorkspace([{ uri: { scheme: 'file', fsPath: '/other' } }]);
    assert.equal(host.lives[0].closed, true);
    assert.equal((observer.webview.messages.at(-1) as any).type, 'workspaceChanged');
    assert.equal(observer.webview.htmlWrites, writes);
  } finally { host.dispose(); }
});

const local = (path: string) => ({ uri: { scheme: 'file', fsPath: path } });
for (const [gap, folders, text] of [
  ['empty', [], '打开一个项目文件夹'],
  ['multi', [local('/fixture'), local('/other')], '暂不支持多文件夹工作区'],
  ['remote', [{ uri: { scheme: 'vscode-remote', fsPath: '/fixture' } }], '暂不支持远程工作区'],
] as const) test(`a ${gap} workspace shows its reason in the view without a warning or a session scan`, async () => {
  const host = harness();
  try {
    host.setFolders([...folders]);
    await host.api.openObserver();
    const html = host.sidebar.webview.html as string;
    assert.match(html, new RegExp(`data-workspace-gap="${gap}"`));
    assert.ok(html.includes(text));
    assert.equal(html.includes('data-action="openFolder"'), gap === 'empty');
    // Palette commands land on the same explanation rather than a warning.
    await host.command('agentSidecar.chooseSession');
    await host.command('agentSidecar.refresh');
    assert.equal(host.pickers.length, 0);
    assert.equal(host.discoveries, 0);
    assert.deepEqual(host.warnings, []);
    if (gap === 'empty') {
      host.receive({ type: 'openFolder' }); await new Promise(resolve => setImmediate(resolve));
      assert.ok(host.executed.includes('vscode.openFolder'));
    }
  } finally { host.dispose(); }
});

test('leaving a multi-folder workspace for one local folder renders a fresh chooser', async () => {
  const host = harness();
  try {
    host.setFolders([local('/fixture'), local('/other')]);
    await host.api.openObserver();
    host.changeWorkspace([local('/fixture')]);
    const html = host.sidebar.webview.html as string;
    assert.ok(!html.includes('data-workspace-gap'));
    assert.ok(html.includes('选择要观察的会话'));
    assert.deepEqual(host.warnings, []);
  } finally { host.dispose(); }
});

test('detail clicks snapshot the evidence synchronously, before any queued work, while live output continues', async () => {
  const host = harness();
  try {
    await host.ready();
    const opening = host.api.openDetail('a:tool');
    // A live update lands before the detail queue gets to run.
    host.lives[0].session.items[0].detail!.blocks[0].text = 'Changed after the click';
    host.lives[0].emit(); await opening;
    assert.equal(host.api.preview?.item.detail?.blocks[0].text, 'PASS');
  } finally { host.dispose(); }
});

test('a slow refresh cannot reselect the old session after a newer explicit selection', async () => {
  const host = harness();
  try {
    await host.ready();
    const scan = deferred<{ candidates: SessionCandidate[]; warnings: string[] }>();
    host.sources.discover = () => scan.promise;
    const refresh = host.api.refresh();
    await host.api.selectSession('claude:b');
    scan.resolve({ candidates: [a, b], warnings: [] });
    await refresh;
    assert.equal(host.api.session?.id, 'b');
    assert.equal(host.state.get('selectedSession'), 'claude:b');
  } finally { host.dispose(); }
});

test('the session picker enriches title, log update time and latest conversation and accepts only the selected identity', async () => {
  const host = harness();
  try {
    await host.ready();
    const listing = deferred<SessionPickerEntry[]>();
    host.metadata.list = () => listing.promise;
    const choosing = host.command('agentSidecar.chooseSession');
    await new Promise(resolve => setImmediate(resolve));
    const picker = host.pickers.at(-1)!;
    assert.ok(picker.shown);
    assert.equal(picker.matchOnDescription, true);
    assert.equal(picker.matchOnDetail, true);
    assert.match(picker.placeholder, /搜索标题或最近对话/);
    assert.equal(picker.busy, true);
    assert.equal(host.api.session?.id, 'a', 'Opening a chooser is not a selection');
    listing.resolve([a, b].map(candidate => ({ ...host.metadataEntry(candidate, true), title: '相同的可读标题', shortId: `safe-${candidate.id}` })));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(picker.items.map(item => item.label), ['相同的可读标题', '相同的可读标题']);
    assert.match(picker.items[0].description!, /Codex · safe-a.*日志更新 2026\/9\/7 10:00:00.*正在观察/);
    assert.match(picker.items[1].description!, /Claude Code · safe-b.*日志更新/);
    assert.equal(picker.items[1].detail, 'Agent：最近公开内容 b');
    assert.equal(picker.busy, false);
    picker.accept('claude:b');
    await choosing;
    assert.equal(host.api.session?.id, 'b');
    assert.equal(host.api.session?.provider, 'claude');
    assert.equal(host.state.get('selectedSession'), 'claude:b', 'Duplicate titles never decide identity');
    assert.equal(picker.disposed, true);
    assert.equal(picker.listenerCount, 0);
    assert.equal(picker.disposeCalls, 1);
  } finally { host.dispose(); }
});

test('cancelled session picking leaves selection intact and late metadata cannot repaint the disposed picker', async () => {
  const host = harness();
  try {
    await host.ready();
    const listing = deferred<SessionPickerEntry[]>();
    const active = deferred<SessionPickerEntry>();
    host.metadata.list = () => listing.promise;
    host.metadata.read = () => active.promise;
    const choosing = host.command('agentSidecar.chooseSession');
    await new Promise(resolve => setImmediate(resolve));
    const picker = host.pickers.at(-1)!;
    picker.activate('claude:b');
    picker.hide();
    await choosing;
    const writes = { items: picker.itemsWrites, busy: picker.busyWrites };
    assert.equal(host.api.session?.id, 'a');
    assert.equal(host.state.get('selectedSession'), 'codex:a');
    assert.equal(picker.disposed, true);
    listing.resolve([host.metadataEntry(a, true), host.metadataEntry(b, true)]);
    active.resolve(host.metadataEntry(b, true));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ items: picker.itemsWrites, busy: picker.busyWrites }, writes);
    assert.equal(picker.listenerCount, 0);
  } finally { host.dispose(); }
});

test('lazy active metadata preserves its identity and cannot be downgraded by a late deferred list entry', async () => {
  const host = harness();
  try {
    await host.ready();
    const listing = deferred<SessionPickerEntry[]>();
    const active = deferred<SessionPickerEntry>();
    const reads: string[] = [];
    host.metadata.list = () => listing.promise;
    host.metadata.read = candidate => { reads.push(`${candidate.provider}:${candidate.id}`); return active.promise; };
    const choosing = host.command('agentSidecar.chooseSession');
    await new Promise(resolve => setImmediate(resolve));
    const picker = host.pickers.at(-1)!;
    picker.activate('claude:b');
    assert.deepEqual(reads, ['claude:b']);
    active.resolve({ ...host.metadataEntry(b, true), title: '用户刚定位的会话', latestRole: 'user', latestText: '用户：最近的问题' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(picker.activeItems[0].key, 'claude:b');
    assert.equal(picker.activeItems[0].label, '用户刚定位的会话');
    listing.resolve([host.metadataEntry(a, true), host.metadataEntry(b)]);
    await new Promise(resolve => setImmediate(resolve));
    const choice = picker.items.find(item => item.key === 'claude:b')!;
    assert.equal(choice.label, '用户刚定位的会话');
    assert.equal(choice.detail, '用户：最近的问题');
    assert.equal(picker.activeItems[0], choice, 'Enrichment restores the active identity using the newly painted item');
    assert.equal(host.api.session?.id, 'a');
    picker.hide(); await choosing;
  } finally { host.dispose(); }
});

test('a stale picker cannot repaint or accept an old identity after an explicit newer session selection', async () => {
  const host = harness();
  try {
    await host.ready();
    const listing = deferred<SessionPickerEntry[]>();
    host.metadata.list = () => listing.promise;
    const choosing = host.command('agentSidecar.chooseSession');
    await new Promise(resolve => setImmediate(resolve));
    const picker = host.pickers.at(-1)!;
    await host.api.selectSession('claude:b');
    const writes = { items: picker.itemsWrites, busy: picker.busyWrites };
    listing.resolve([host.metadataEntry(a, true), host.metadataEntry(b, true)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ items: picker.itemsWrites, busy: picker.busyWrites }, writes);
    picker.accept('codex:a'); await choosing;
    assert.equal(host.api.session?.id, 'b');
    assert.equal(host.state.get('selectedSession'), 'claude:b');
  } finally { host.dispose(); }
});

test('extension disposal settles the chooser, removes listeners and ignores all pending metadata', async () => {
  const host = harness();
  let picker: (typeof host.pickers)[number] | undefined;
  try {
    await host.ready();
    const listing = deferred<SessionPickerEntry[]>();
    const active = deferred<SessionPickerEntry>();
    host.metadata.list = () => listing.promise;
    host.metadata.read = () => active.promise;
    let settled = false;
    const choosing = host.command('agentSidecar.chooseSession').then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    picker = host.pickers.at(-1)!;
    picker.activate('claude:b');
    host.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(picker.disposed, true);
    assert.equal(picker.listenerCount, 0);
    assert.equal(settled, true, 'Disposal must not leave an unresolved chooseSession invocation');
    const writes = { items: picker.itemsWrites, busy: picker.busyWrites };
    listing.resolve([host.metadataEntry(a, true), host.metadataEntry(b, true)]);
    active.resolve(host.metadataEntry(b, true));
    await choosing;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ items: picker.itemsWrites, busy: picker.busyWrites }, writes);
  } finally { picker?.hide(); host.dispose(); }
});

test('the sidebar Sidecar and its details never read or change the editor layout, and Keep survives reuse', async () => {
  const host = harness();
  try {
    await host.ready();
    host.focusColumn(2);
    const before = { reads: host.layoutReads, focus: host.focusCommands, session: host.api.session };
    assert.deepEqual(host.layoutWrites, [], 'Opening the sidebar view inserts no editor group');
    await host.api.openDetail('a:tool');
    const first = host.api.preview!;
    // Opened in the editor area where the reader is, without taking focus.
    assert.equal(first.panel.viewColumn, -1);
    assert.equal(host.activeColumn, 2);
    assert.equal(host.api.evidence.length, 1);
    await host.api.openDetail('a:tool');
    assert.equal(host.api.preview, first, 'The preview is reused in place');
    const preserved = JSON.stringify(first.item);
    host.api.keepEvidence();
    await host.api.openDetail('a:tool');
    assert.notEqual(host.api.preview, first);
    assert.equal(first.kept, true);
    assert.equal(JSON.stringify(first.item), preserved);
    assert.equal(host.api.evidence.length, 2);
    assert.deepEqual({ writes: host.layoutWrites, reads: host.layoutReads, focus: host.focusCommands, active: host.activeColumn, session: host.api.session },
      { writes: [], reads: before.reads, focus: before.focus, active: 2, session: before.session });
  } finally { host.dispose(); }
});

test('coverage opens in the editor area for either provider without touching the layout', async () => {
  const host = harness();
  try {
    await host.ready();
    await host.api.selectSession('claude:b');
    await host.command('agentSidecar.coverage');
    assert.deepEqual(host.warnings, []);
    assert.equal(host.documents.size, 1);
    assert.match([...host.documents.values()][0].text, /回合连续排列/);
    assert.ok(![...host.documents.values()][0].text.includes('正文只显示选中回合'));
    assert.equal(host.api.preview, undefined);
    assert.deepEqual(host.layoutWrites, []);
    assert.equal(host.groupCount, 1);
    assert.equal(host.api.session?.provider, 'claude');
  } finally { host.dispose(); }
});

test('a preview opened while the next session was loading is closed when that session binds', async () => {
  const host = harness();
  try {
    await host.ready();
    const load = deferred<SessionData>();
    host.sources.load = candidate => candidate.id === 'b' ? load.promise : Promise.resolve(data(candidate));
    const selection = host.api.selectSession('claude:b');
    await host.api.openDetail('a:tool');
    assert.equal(host.api.preview?.item.sessionId, 'a');
    load.resolve(data(b));
    await selection;
    assert.equal(host.api.session?.id, 'b');
    assert.equal(host.api.preview, undefined, 'The old session’s temporary preview does not survive the switch');
    assert.equal(host.api.evidence.length, 0);
  } finally { host.dispose(); }
});

test('switching sessions closes the temporary preview but keeps kept details as their own snapshots', async () => {
  const host = harness();
  try {
    await host.ready();
    await host.api.openDetail('a:tool');
    host.api.keepEvidence();
    const kept = host.api.evidence[0];
    await host.api.openDetail('a:tool');
    const temporary = host.api.preview!;
    await host.api.selectSession('claude:b');
    assert.equal(host.api.session?.provider, 'claude');
    assert.equal((temporary.panel as unknown as { disposed: boolean }).disposed, true);
    assert.equal(host.api.preview, undefined);
    assert.deepEqual(host.api.evidence, [kept], 'A kept detail stays open');
    assert.equal(kept.provider, 'codex');
    assert.equal(kept.item.sessionId, 'a');
    await host.api.openDetail('b:tool');
    // Read through a widened type: the assertion above narrowed `preview` to undefined.
    const next = (host.api as { preview?: { provider: string } }).preview;
    assert.equal(next?.provider, 'claude', 'A new preview belongs only to the new session');
    assert.notEqual(next, kept);
  } finally { host.dispose(); }
});

test('refresh emits a coverage-provider update for an already-open same-session document', async () => {
  const host = harness();
  try {
    await host.ready();
    await host.command('agentSidecar.coverage');
    const doc = [...host.documents.values()][0];
    assert.ok(doc);
    host.sources.load = async candidate => ({ ...data(candidate), warnings: ['新快照包含源截断说明'] });
    await host.api.refresh();
    assert.match(doc.text, /新快照包含源截断说明/);
    assert.deepEqual(host.warnings, []);
  } finally { host.dispose(); }
});

test('Keep confirms the existing detail page without replacing HTML or returning focus to Sidecar', async () => {
  const host = harness();
  try {
    await host.ready();
    await host.api.openDetail('a:tool');
    const view = host.api.preview!;
    const webview = view.panel.webview as unknown as { html: string; htmlWrites: number; messages: unknown[] };
    const before = { html: webview.html, writes: webview.htmlWrites, reveals: host.revealCalls };
    host.focusColumn(3);
    host.api.keepEvidence();
    assert.equal(view.kept, true);
    assert.equal(host.api.preview, undefined);
    assert.equal(host.api.evidence[0], view);
    assert.equal(webview.html, before.html);
    assert.equal(webview.htmlWrites, before.writes);
    assert.deepEqual(webview.messages, [{ type: 'kept' }]);
    assert.equal(host.activeColumn, 3);
    assert.equal(host.revealCalls, before.reveals);
    assert.match(view.panel.title, /^已保留/);
  } finally { host.dispose(); }
});

test('semantic action evidence opens in the editor area with cloned constituent records and reuses the preview safely', async () => {
  const host = harness();
  try {
    host.sources.load = async candidate => aggregateData(candidate);
    await host.ready();
    const source = host.api.session!;
    const row = rows(source).find(row => row.items.length === 2)!;
    assert.ok(row);
    await host.api.openDetail(row.id);
    const preview = host.api.preview!;
    assert.equal(preview.panel.viewColumn, -1);
    assert.equal(host.activeColumn, 1);
    assert.equal(preview.item.title, row.description.label);
    assert.deepEqual(preview.items, row.items);
    assert.notEqual(preview.items, row.items);
    assert.notEqual(preview.items![0], row.items[0]);
    assert.notEqual(preview.items![0].detail, row.items[0].detail);
    const text = preview.panel.webview.html.replace(/<[^>]+>/g, '');
    assert.match(text, /独立输出 0/);
    assert.match(text, /独立输出 1/);
    assert.match(preview.panel.webview.html, /来源范围 0/);
    assert.match(preview.panel.webview.html, /来源范围 1/);
    await host.api.openDetail('a:tool');
    assert.equal(host.api.preview, preview);
    assert.equal(preview.item.id, 'a:tool');
    assert.equal(preview.items, undefined, 'Replacing a group preview with an original record must clear prior members');
    assert.equal(host.api.evidence.length, 1);
    assert.equal(host.activeColumn, 1);
    await host.api.openDetail(row.id);
    assert.equal(host.api.preview, preview);
    assert.deepEqual(host.api.preview?.items?.map(item => item.id), row.items.map(item => item.id));
    assert.equal(host.api.evidence.length, 1);
  } finally { host.dispose(); }
});

test('Keep preserves grouped evidence snapshots while later single-record previews remain independent', async () => {
  const host = harness();
  try {
    host.sources.load = async candidate => aggregateData(candidate);
    await host.ready();
    const row = rows(host.api.session!).find(row => row.items.length === 2)!;
    await host.api.openDetail(row.id);
    const kept = host.api.preview!;
    const before = JSON.stringify(kept.items);
    host.api.keepEvidence();
    await host.api.openDetail('a:tool');
    assert.equal(kept.kept, true);
    assert.notEqual(host.api.preview, kept);
    assert.equal(host.api.preview?.items, undefined);
    assert.equal(host.api.evidence.length, 2);
    assert.equal(JSON.stringify(kept.items), before);
    row.items[0].summary = '模拟后续来源变化';
    assert.equal(JSON.stringify(kept.items), before, 'Kept evidence has no live references to mutable session observations');
  } finally { host.dispose(); }
});

test('compact detail keeps every original source in closed disclosures and Keep does not rewrite the page or its records', async () => {
  const host = harness();
  try {
    host.sources.load = async candidate => aggregateData(candidate);
    await host.ready();
    const source = host.api.session!;
    const row = rows(source).find(row => row.items.length === 2)!;
    assert.ok(row);
    const originalSnapshot = JSON.stringify(source.items);
    await host.api.openDetail(row.id);
    const view = host.api.preview!;
    const webview = view.panel.webview as unknown as { html: string; htmlWrites: number; messages: unknown[] };
    const disclosures = [...webview.html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)]
      .filter(match => /\bdata-evidence-source\b/.test(match[1]));
    assert.ok(disclosures.length);
    assert.ok(disclosures.every(match => !/\bopen(?:\s|=|$)/.test(match[1])));
    assert.ok(disclosures.every(match => match[2].includes('class="source-list"')));
    row.items.forEach((original, index) => {
      assert.notEqual(view.items![index], original);
      assert.deepEqual(view.items![index], original);
      assert.ok(webview.html.includes(`来源范围 ${index}`));
      assert.ok(disclosures.some(match => match[2].includes(`来源范围 ${index}`)), 'Source notes remain available without occupying the reading surface');
      assert.ok(disclosures.some(match => match[2].includes(`${a.file}:${index + 3}`)));
    });
    const text = webview.html.replace(/<[^>]+>/g, '');
    assert.ok(text.indexOf('独立输出 0') >= 0 && text.indexOf('独立输出 0') < text.indexOf('独立输出 1'));
    const before = { html: webview.html, writes: webview.htmlWrites, reveals: host.revealCalls,
      records: JSON.stringify({ item: view.item, items: view.items }), layout: [...host.layoutWrites] };
    host.focusColumn(3);
    host.api.keepEvidence();
    assert.equal(view.kept, true);
    assert.equal(webview.html, before.html);
    assert.equal(webview.htmlWrites, before.writes);
    assert.deepEqual(webview.messages, [{ type: 'kept' }]);
    assert.equal(JSON.stringify({ item: view.item, items: view.items }), before.records);
    assert.deepEqual(host.layoutWrites, before.layout);
    assert.equal(host.revealCalls, before.reveals);
    assert.equal(host.activeColumn, 3);
    await host.api.openDetail('a:tool');
    assert.notEqual(host.api.preview!.panel, view.panel);
    assert.equal(JSON.stringify({ item: view.item, items: view.items }), before.records);
    assert.equal(webview.html, before.html);
    assert.equal(JSON.stringify(source.items), originalSnapshot);
  } finally { host.dispose(); }
});

test('empty or unavailable semantic rows and original records do not create a detail group', async () => {
  const host = harness();
  try {
    host.sources.load = async candidate => {
      const snapshot = aggregateData(candidate);
      snapshot.items = snapshot.items.map(item => ({ ...item, detail: { title: '无有效正文', blocks: [{ kind: 'text', label: '空白', text: '  ' }] } }));
      return snapshot;
    };
    await host.ready();
    const initialWrites = [...host.layoutWrites];
    for (const row of rows(host.api.session!)) await host.api.openDetail(row.id);
    for (const item of host.api.session!.items) await host.api.openDetail(item.id);
    assert.equal(host.api.preview, undefined);
    assert.equal(host.api.evidence.length, 0);
    assert.equal(host.groupCount, 1);
    assert.deepEqual(host.layoutWrites, initialWrites);
  } finally { host.dispose(); }
});

test('an aggregate preview keeps its own session members until a switch closes it', async () => {
  const host = harness();
  try {
    host.sources.load = async candidate => aggregateData(candidate);
    await host.ready();
    const row = rows(host.api.session!).find(row => row.items.length === 2)!;
    await host.api.openDetail(row.id);
    assert.deepEqual(host.api.preview?.items?.map(item => item.sessionId), row.items.map(() => 'a'));
    await host.api.selectSession('claude:b');
    assert.equal(host.api.session?.provider, 'claude');
    assert.equal(host.api.preview, undefined);
    assert.equal(host.api.evidence.length, 0);
    assert.deepEqual(host.warnings, []);
  } finally { host.dispose(); }
});

test('coverage report links each original action to semantic detail rows without copying result content', async () => {
  const host = harness();
  try {
    host.sources.load = async candidate => aggregateData(candidate);
    await host.ready();
    await host.command('agentSidecar.coverage');
    const doc = [...host.documents.values()][0];
    const report = JSON.parse(doc.text) as { presentation: { items: Array<{ itemId: string; surface: string; rowIds: string[] }> } };
    assert.equal(report.presentation.items.length, host.api.session!.items.length);
    const displayedRows = groupSessionTurns(host.api.session!).flatMap(turn => outlineTurn(turn).nodes.flatMap(node =>
      node.kind === 'actions' ? actionRowSections(node).flatMap(section => section.rows) : []));
    for (const item of host.api.session!.items.filter(item => item.kind === 'tool')) {
      const route = report.presentation.items.find(value => value.itemId === item.id)!;
      assert.equal(route.surface, 'action-detail');
      assert.deepEqual(route.rowIds, displayedRows.filter(row => row.items.includes(item)).map(row => row.id));
      assert.ok(route.rowIds.length > 0);
    }
    assert.ok(!doc.text.includes('独立输出'));
    assert.ok(!doc.text.includes('来源范围'));
  } finally { host.dispose(); }
});

// A transcript the integration points at must exist before the window follows it.
const transcript = () => { const file = join(mkdtempSync(join(tmpdir(), 'sidecar-follow-')), 'b.jsonl'); writeFileSync(file, '{}\n'); return file; };
const liveState = (session: string, extra: Partial<SessionState> = {}): SessionState => ({ provider: session === 'a' ? 'codex' : 'claude', session, transcript: transcript(),
  cwd: '/fixture', agentPid: process.pid, hostPid: process.pid, startedAt: 1, activeAt: 5, phase: 'working', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const posted = (host: ReturnType<typeof harness>, type: string) => (host.api.observer as any).webview.messages.filter((message: any) => message.type === type);
/** The follow button as the reader sees it: the page's HTML, then any later follow message. */
const followButtonShown = (host: ReturnType<typeof harness>, messagesBefore: number) => {
  const html: string = (host.api.observer as any).webview.html;
  const later = posted(host, 'follow').slice(messagesBefore);
  return later.length ? later.at(-1).paused : !/data-action="resumeFollow"[^>]* hidden>/.test(html.slice(html.indexOf('<main')));
};

test('the window follows its own current session, and only that one', async () => {
  const host = harness();
  try {
    await host.ready();
    assert.equal(host.api.session?.id, 'a');
    host.sessionStates.list = [liveState('b', { hostPid: process.pid + 1 })];
    await host.api.refreshStates();
    assert.equal(host.api.session?.id, 'a', 'Another window\u2019s session is not followed');
    host.sessionStates.list = [liveState('b', { cwd: '/elsewhere' })];
    await host.api.refreshStates();
    assert.equal(host.api.session?.id, 'a', 'Another project\u2019s session is not followed');
    host.sessionStates.list = [liveState('b', { transcript: '/fixture/not-written-yet.jsonl' })];
    await host.api.refreshStates();
    assert.equal(host.api.session?.id, 'a', 'Nothing to read before the agent writes its transcript');
    host.sessionStates.list = [liveState('a', { activeAt: 3 }), liveState('b', { activeAt: 9 })];
    await host.api.refreshStates();
    assert.equal(host.api.session?.id, 'b', 'The most recently active of this window\u2019s sessions');
    assert.deepEqual(host.warnings, []);
  } finally { host.dispose(); }
});

test('choosing another session pauses following until the reader resumes it', async () => {
  const host = harness();
  try {
    await host.ready();
    host.sessionStates.list = [liveState('b')];
    await host.api.refreshStates();
    assert.equal(host.api.session?.id, 'b');
    const choosing = host.command('agentSidecar.chooseSession');
    await tick();
    host.pickers.at(-1)!.accept('codex:a');
    await choosing;
    assert.equal(host.api.session?.id, 'a');
    assert.equal(host.api.following, false);
    assert.equal(followButtonShown(host, 0), true);
    host.sessionStates.list = [liveState('b', { activeAt: 50 })];
    await host.api.refreshStates();
    assert.equal(host.api.session?.id, 'a', 'New activity does not override the reader\u2019s choice');
    const before = posted(host, 'follow').length;
    host.receive({ type: 'resumeFollow' });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(host.api.session?.id, 'b');
    assert.equal(followButtonShown(host, before), false);
    const count = posted(host, 'follow').length;
    for (let i = 0; i < 3; i++) await host.api.refreshStates();
    assert.equal(posted(host, 'follow').length, count, 'An unchanged follow state is not posted again');
  } finally { host.dispose(); }
});

test('an approval and text on screen reach the newest turn without a new record', async () => {
  const host = harness();
  try {
    await host.ready();
    host.sessionStates.list = [liveState('a', { phase: 'waiting', approval: { tool: 'Write', summary: '/fixture/numbers.txt', at: 1 } })];
    await host.api.refreshStates(); for (let i = 0; i < 3; i++) await tick();
    const waiting = posted(host, 'observation').at(-1);
    assert.ok(waiting.turns.some((turn: any) => turn.html.includes('等你批准') && turn.html.includes('Write numbers.txt')));
    host.sessionStates.list = [liveState('a', { phase: 'idle' })];
    await host.api.refreshStates(); for (let i = 0; i < 3; i++) await tick();
    assert.ok(!posted(host, 'observation').at(-1).turns.some((turn: any) => turn.html.includes('等你批准')), 'Answered: the wait is gone');
    const count = posted(host, 'observation').length;
    await host.api.refreshStates(); for (let i = 0; i < 3; i++) await tick();
    assert.equal(posted(host, 'observation').length, count, 'Unchanged state posts nothing');
  } finally { host.dispose(); }
});

test('an active session with no integration state suggests the integration once, until dismissed', async () => {
  const host = harness();
  try {
    const load = host.sources.load;
    host.sources.load = async candidate => { const snapshot = await load(candidate); snapshot.items[0].timestamp = new Date().toISOString(); return snapshot; };
    await host.ready();
    await host.api.refreshStates();
    assert.equal(posted(host, 'integrationHint').at(-1)?.show, true);
    host.sessionStates.list = [liveState('a')];
    await host.api.refreshStates();
    assert.equal(posted(host, 'integrationHint').at(-1).show, false, 'Installed: nothing to suggest');
    host.sessionStates.list = [];
    await host.api.refreshStates();
    host.receive({ type: 'dismissHint' });
    for (let i = 0; i < 3; i++) await tick();
    assert.equal(posted(host, 'integrationHint').at(-1).show, false);
    assert.equal(host.globals.get('integrationHintDismissed'), true);
  } finally { host.dispose(); }
});
