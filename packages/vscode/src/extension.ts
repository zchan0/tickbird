import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { discoverSessions, sessionKey, type DiscoveryOptions } from '../../core/src/sessions';
import { openLiveSession, type LiveSession } from '../../core/src/live-session';
import { LiveView } from './live-view';
import type { SessionCandidate, SessionData, TimelineItem, Provider } from '../../core/src/model';
import { renderDetail, renderSidecar, renderInlineEvidence, inlineRevision, renderWorkspaceGap, workspaceGaps, type WorkspaceGap } from './render';
import { hasReadableEvidence, outlineCoverage, resolveOutlineEvidence } from '../../core/src/outline';
import { currentSession, readSessionStates, sessionStateDirectory, type SessionState, type SessionStateCache } from '../../core/src/session-state';
import { lastRecordAt, liveExtras as coreLiveExtras, type LiveExtras } from '../../core/src/live-extras';
import { createSessionPickerMetadata, type SessionPickerEntry } from '../../core/src/session-picker';
import { callLink, fileChanges, fileRead, findRow, locateLines, recordedImage, rowChanges, turnRows } from '../../core/src/call-target';
import { callEnd, callText, callTool } from '../../core/src/call-line';
import type { PatchFile } from '../../core/src/presentation';

interface EvidenceView { panel: vscode.WebviewPanel; item: TimelineItem; items?: TimelineItem[]; provider: Provider; kept: boolean;
  /** The call the detail is about, named as its line in the panel names it. */
  call?: { tool: string; label: string; word?: string };
  /** A change shown as its diff: every change to the file in the turn, the one on screen, its path as shown. */
  change?: { steps: PatchFile[]; index: number; path: string; title: string } }
const observerType = 'agentSidecar.observer';

export function activate(context: vscode.ExtensionContext) {
  let observer: vscode.WebviewView | undefined;
  let session: SessionData | undefined;
  let live: LiveSession | undefined;
  let liveView: LiveView | undefined;
  let loading: AbortController | undefined;
  let delivery: Promise<unknown> = Promise.resolve();
  let candidate: SessionCandidate | undefined;
  let candidates: SessionCandidate[] = [];
  let preview: EvidenceView | undefined;
  const evidence = new Set<EvidenceView>();
  let generation = 0;
  // What the integration hooks say about live sessions; see docs/SESSION_STATE.md.
  const stateDirectory = sessionStateDirectory();
  const stateCache: SessionStateCache = new Map();
  let states: SessionState[] = [];
  /** Off once the reader chooses a session other than this window's current one. */
  let follow = true;
  let currentKey: string | undefined;
  let following: Promise<void> | undefined;
  let publishedExtras = '';
  let postedPaused: boolean | undefined;
  let hintShown = false;
  let scanGeneration = 0;
  let disposed = false;
  let resolved: (() => void) | undefined;
  let opening: Promise<void> | undefined;
  let detailOpening: Promise<void> = Promise.resolve();
  let selectionPersistence: Promise<void> = Promise.resolve();
  const nonce = () => randomBytes(18).toString('base64');
  const coverageDocuments = new Map<string, string>();
  const coverageChanged = new vscode.EventEmitter<vscode.Uri>();
  const reportError = (error: unknown) => vscode.window.showWarningMessage(`Agent Sidecar：${error instanceof Error ? error.message : String(error)}`);

  /** Sessions are matched by one local project directory; any other workspace is explained in the view itself. */
  function workspaceGap(): WorkspaceGap | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!vscode.workspace.isTrusted) return 'untrusted';
    if (!folders.length) return 'empty';
    if (folders.length > 1) return 'multi';
    return folders[0].uri.scheme === 'file' ? undefined : 'remote';
  }
  let gapShown: WorkspaceGap | undefined;
  function projectPath(): string {
    const gap = workspaceGap();
    if (gap) throw new Error(workspaceGaps[gap].title);
    return vscode.workspace.workspaceFolders![0].uri.fsPath;
  }
  function discoveryOptions(): DiscoveryOptions {
    const test = context.extensionMode === vscode.ExtensionMode.Test;
    return { projectPath: projectPath(),
      codexRoot: test ? process.env.SIDECAR_TEST_CODEX_ROOT : undefined,
      claudeRoot: test ? process.env.SIDECAR_TEST_CLAUDE_ROOT : undefined };
  }
  async function scan() {
    const token = ++scanGeneration;
    const result = await discoverSessions(discoveryOptions());
    if (!disposed && token === scanGeneration) candidates = result.candidates;
    return result;
  }
  /** The session's name, in the view's title bar after its name: only a name the agent saved, never the first request. */
  function describe(snapshot: SessionData | undefined) {
    if (!observer) return;
    const named = snapshot && (snapshot.titleSource === 'claude-ai-title' || snapshot.titleSource === 'codex-index') ? snapshot.title : undefined;
    // A container's only view shows its title, not its description: the name goes in the title, 过程 without one.
    const title = named ?? '过程';
    if (observer.title !== title) observer.title = title;
  }
  function renderObserver() {
    if (!observer) return;
    describe(workspaceGap() ? undefined : session);
    gapShown = workspaceGap();
    if (gapShown) observer.webview.html = renderWorkspaceGap(gapShown, nonce(), vscode.env?.language);
    else {
      postedPaused = followPaused();
      observer.webview.html = renderSidecar({ projectName: basename(projectPath()), session, nonce: nonce(), streamId: liveView?.streamId, locale: vscode.env?.language,
        followPaused: postedPaused, integrationHint: hintShown }, liveView?.current);
    }
  }
  /** The approval the newest turn waits for and the text on screen, when the integration reports them. */
  function liveExtras(snapshot: SessionData | undefined): LiveExtras {
    return coreLiveExtras(snapshot, snapshot && states.find(item => item.provider === snapshot.provider && item.session === snapshot.id));
  }
  function followPaused(): boolean {
    return !follow && Boolean(currentKey) && (!candidate || sessionKey(candidate) !== currentKey);
  }
  /** Tells the page only when the paused state changes; `force` after the page was rebuilt. */
  function postFollowState(force = false) {
    const paused = followPaused();
    if (!observer || gapShown || disposed || (!force && paused === postedPaused)) return;
    postedPaused = paused;
    void Promise.resolve(observer.webview.postMessage({ type: 'follow', paused })).catch(() => undefined);
  }
  function publish(reset = false) {
    const source = live, view = liveView, panel = observer;
    if (!source || !view || !panel || disposed) return;
    const extras = liveExtras(source.session);
    publishedExtras = JSON.stringify(extras);
    describe(source.session);
    const message = view.update(source.session, source.health, reset, extras);
    delivery = delivery.catch(() => undefined).then(async () => {
      if (!disposed && live === source && observer === panel) await panel.webview.postMessage(message);
    });
    // Delivery failure is recovered by the Webview's version/resync handshake.
    void delivery.catch(() => undefined);
  }
  function stopObservation() {
    loading?.abort(); loading = undefined;
    const source = live; live = undefined; liveView = undefined;
    if (source) void source.close().catch(() => undefined);
  }
  function renderEvidence(view: EvidenceView) {
    view.panel.title = `${view.kept ? '已保留' : '预览'} · ${view.change?.title ?? view.call?.label ?? view.item.title}`;
    view.panel.webview.html = renderDetail({ item: view.item, items: view.items, provider: view.provider, kept: view.kept, nonce: nonce(), locale: vscode.env?.language, ...(view.call ? { call: view.call } : {}), ...(view.change ? { change: { files: [view.change.steps[view.change.index]], paths: [view.change.path], title: view.change.title,
      ...(view.change.steps.length > 1 ? { edit: { index: view.change.index, total: view.change.steps.length } } : {}) } } : {}) });
  }
  /**
   * Switching sessions closes the temporary preview, which belongs to the old
   * session. A kept detail is an independent snapshot of its own session and
   * provider, so it stays open; nothing from it is carried into the new one.
   */
  function checkSessionChange(key: string) {
    if (candidate && key !== sessionKey(candidate) && preview) preview.panel.dispose();
  }
  async function selectSession(key: string, token = ++generation) {
    if (disposed || token !== generation) return;
    checkSessionChange(key);
    const selected = candidates.find(item => sessionKey(item) === key);
    if (!selected) throw new Error('选定会话当前不可用；未自动替换或清除已保存选择。');
    loading?.abort();
    const controller = new AbortController(); loading = controller;
    let opened: LiveSession;
    try { opened = await openLiveSession(selected, { signal: controller.signal }); }
    catch (error) { if (controller.signal.aborted) return; throw error; }
    finally { if (loading === controller) loading = undefined; }
    if (disposed || token !== generation || !observer) { await opened.close(); return; }
    // A detail may have opened while the selected log was loading.
    try { checkSessionChange(key); if (selected.projectPath !== await realpath(projectPath())) throw new Error('工作区已改变；未绑定旧项目会话。'); }
    catch (error) { await opened.close(); throw error; }
    if (disposed || token !== generation || !observer) { await opened.close(); return; }
    const previous = live;
    live = opened;
    liveView = new LiveView(basename(projectPath()), opened.session, vscode.env?.language, liveExtras(opened.session));
    candidate = selected;
    session = opened.session;
    renderObserver();
    opened.start(() => {
      if (disposed || live !== opened || !observer) return;
      publish();
      if (coverageDocuments.has(coverageUri(opened.session).toString())) updateCoverageDocument(opened.session);
    });
    if (previous) void previous.close().catch(() => undefined);
    if (coverageDocuments.has(coverageUri(session).toString())) updateCoverageDocument(session);
    // Persist committed selections in commit order, even if storage resolves slowly.
    const persisted = selectionPersistence.then(() => context.workspaceState.update('selectedSession', key));
    selectionPersistence = persisted.then(() => undefined, () => undefined);
    await persisted;
  }
  async function chooseSession() {
    await openObserver();
    if (workspaceGap()) return;
    const token = ++generation;
    const result = await scan();
    if (disposed || token !== generation) return;
    if (!candidates.length) {
      throw new Error(`没有取得可验证的当前项目候选。无候选恢复规则待确认，本次不自动选择其他项目。${result.warnings.join(' ')}`);
    }
    const choices = [...candidates];
    const metadata = createSessionPickerMetadata();
    const entries = new Map(choices.map(item => [sessionKey(item), metadata.base(item)]));
    type Choice = vscode.QuickPickItem & { key: string };
    const picker = vscode.window.createQuickPick<Choice>();
    picker.title = '切换会话';
    picker.placeholder = '搜索标题或最近对话 · 仅当前项目';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    let closed = false;
    const paint = () => {
      if (closed || disposed || token !== generation) return;
      const active = picker.activeItems[0]?.key;
      picker.items = choices.map(item => {
        const entry = entries.get(sessionKey(item))!;
        return { key: entry.key, label: entry.title,
          description: `${entry.providerLabel} · ${entry.shortId} · ${entry.updatedLabel}${candidate && entry.key === sessionKey(candidate) ? ' · 正在观察' : ''}`,
          detail: entry.latestText || entry.reason };
      });
      const restored = picker.items.find(item => item.key === active);
      if (restored) picker.activeItems = [restored];
    };
    const merge = (updates: SessionPickerEntry[]) => {
      if (closed || disposed || token !== generation) return;
      let changed = false;
      for (const entry of updates) {
        const previous = entries.get(entry.key);
        if (previous?.metadataStatus === 'ready' && entry.metadataStatus !== 'ready') continue;
        if (previous === entry) continue;
        entries.set(entry.key, entry); changed = true;
      }
      if (changed) paint();
    };
    let closePicker: () => void = () => undefined;
    const pickerLifetime = new vscode.Disposable(() => closePicker());
    context.subscriptions.push(pickerLifetime);
    const selected = new Promise<string | undefined>(resolve => {
      const listeners: vscode.Disposable[] = [];
      closePicker = () => {
        if (closed) return;
        closed = true;
        resolve(undefined);
        listeners.forEach(listener => listener.dispose());
        picker.dispose();
        const index = context.subscriptions.indexOf(pickerLifetime);
        if (index >= 0) context.subscriptions.splice(index, 1);
      };
      listeners.push(picker.onDidChangeActive(items => {
        const current = items[0] && choices.find(item => sessionKey(item) === items[0].key);
        if (current && entries.get(sessionKey(current))?.metadataStatus === 'deferred')
          void metadata.read(current).then(entry => merge([entry]));
      }));
      listeners.push(picker.onDidAccept(() => {
        const choice = picker.selectedItems[0];
        if (choice) { resolve(choice.key); picker.hide(); }
      }));
      listeners.push(picker.onDidHide(closePicker));
    });
    paint();
    picker.busy = true;
    picker.show();
    void metadata.list(choices).then(merge).catch(() => undefined)
      .finally(() => { if (!closed && !disposed && token === generation) picker.busy = false; });
    const picked = await selected;
    // Choosing another session than this window's current one pauses following.
    if (picked && !disposed && token === generation) { follow = !currentKey || picked === currentKey; await selectSession(picked, token); postFollowState(); }
  }
  async function refresh() {
    const token = ++generation;
    if (workspaceGap()) { renderObserver(); return; }
    const key = candidate ? sessionKey(candidate) : context.workspaceState.get<string>('selectedSession');
    await scan();
    if (disposed || token !== generation) return;
    if (key) await selectSession(key, token);
    else renderObserver();
  }

  /** The Sidecar is a sidebar view: it owns no editor group and never changes the editor layout. */
  function attachObserver(view: vscode.WebviewView) {
    observer = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.onDidDispose(() => { if (observer === view) { ++generation; stopObservation(); observer = undefined; } }, null, context.subscriptions);
    view.onDidChangeVisibility(() => { if (observer === view && view.visible) publish(true); }, null, context.subscriptions);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      if (observer !== view) return;
      const value = message as { type?: unknown; itemId?: unknown; path?: unknown; streamId?: unknown; sessionId?: unknown; requestId?: unknown };
      let action: Promise<unknown> | undefined;
      if (value.type === 'observerReady' && value.streamId === liveView?.streamId && liveView) publish(true);
      else if (value.type === 'chooseSession') action = chooseSession();
      else if (value.type === 'refresh') action = refresh();
      else if (value.type === 'coverage') action = showCoverage();
      // Without a URI, the public command asks for the folder in a native dialog.
      else if (value.type === 'openFolder') action = Promise.resolve(vscode.commands.executeCommand('vscode.openFolder'));
      else if (value.type === 'resumeFollow') { follow = true; action = followCurrent(); }
      else if (value.type === 'dismissHint') action = dismissHint();
      else if (value.type === 'keep') { keepEvidence(); }
      else if (value.type === 'openDetail' && typeof value.itemId === 'string') action = openDetail(value.itemId, typeof value.path === 'string' && value.path.length < 4096 ? value.path : undefined);
      else if (value.type === 'loadInlineEvidence' && session && value.sessionId === sessionKey(session) && typeof value.itemId === 'string' && typeof value.requestId === 'string' && value.requestId.length < 40) {
        const evidence = resolveOutlineEvidence(session, value.itemId);
        if (evidence) action = Promise.resolve(view.webview.postMessage({ type: 'inlineEvidence', sessionId: value.sessionId, itemId: value.itemId, requestId: value.requestId,
          revision: inlineRevision(evidence.items ?? [evidence.item]), html: renderInlineEvidence(evidence) }));
      }
      if (action) void action.catch(reportError);
    }, null, context.subscriptions);
    renderObserver();
  }
  async function openObserver() {
    if (observer) { observer.show(false); return; }
    if (opening) return opening;
    opening = (async () => {
      const shown = new Promise<void>(done => { resolved = done; });
      // `<viewId>.focus` is generated by VS Code for every contributed view.
      await vscode.commands.executeCommand(`${observerType}.focus`);
      await shown;
    })();
    try { await opening; } finally { opening = undefined; }
  }
  /** Details open in the editor area, where the reader already is; the preview stays where they put it. */
  function detailColumn(): vscode.ViewColumn {
    return preview?.panel.viewColumn ?? vscode.ViewColumn.Active;
  }
  const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };
  /**
   * What a call points at opens itself, as in the terminal: the file it read,
   * at the lines it read; the image it looked at; the address it fetched. Only
   * what is still there: a file since deleted opens as the record of the time.
   */
  async function openTarget(target: { path?: string; url?: string; lines?: { start: number; count: number; read: string[] } }): Promise<boolean> {
    if (target.url) { await vscode.env.openExternal(vscode.Uri.parse(target.url)); return true; }
    if (!target.path || !await isFile(target.path)) return false;
    const options = { viewColumn: detailColumn(), preview: true, preserveFocus: true };
    if (!target.lines) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.path), options); return true; }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.path));
    // The file may have changed since: the lines read then, where they are now; gone, the record of the time opens instead.
    const found = locateLines(document.getText().split(/\r?\n/), target.lines.read, target.lines.start);
    if (found === undefined) return false;
    const last = Math.max(0, document.lineCount - 1), start = Math.min(last, found - 1), end = Math.min(last, start + Math.max(0, target.lines.count - 1));
    await vscode.window.showTextDocument(document, { ...options, selection: new vscode.Range(start, 0, end, document.lineAt(end).text.length) });
    return true;
  }
  /** `path`: the file a line in Changes stands for, when its call changed several. */
  function openDetail(id: string, path?: string): Promise<void> {
    const boundSession = session;
    const boundObserver = observer;
    // Capture before either the detail queue or a layout change can yield.
    const resolved = boundSession && resolveOutlineEvidence(boundSession, id);
    const snapshot = resolved && structuredClone(resolved);
    const found = boundSession && findRow(boundSession, id);
    const read = found && fileRead(boundSession, found.row);
    const image = found && recordedImage(boundSession, found.row);
    const link = found && callLink(boundSession, found.row);
    const target = image?.path ? { path: image.path } : link ? (/^https?:/.test(link.target) ? { url: link.target } : { path: link.target })
      : read ? { path: read.path, lines: { start: read.start ?? 1, count: read.count, read: read.lines } } : undefined;
    // A change opens as one file's diff, as in the terminal: this call's change to it, and the turn's other changes to it to step through.
    const files = found && !target ? rowChanges(boundSession, found.row) : [];
    const shown = files.find(file => file.path === path)?.path ?? files[0]?.path;
    const root = boundSession ? boundSession.projectPath.replace(/\/$/, '') + '/' : '';
    let change: EvidenceView['change'];
    if (found && boundSession && shown) {
      const steps = fileChanges(boundSession, turnRows(found.group), shown);
      const own = steps.findIndex(step => step.row.id === found.row.id);
      change = { steps: structuredClone(steps.length ? steps.map(step => step.file) : files.filter(file => file.path === shown)), index: Math.max(0, own),
        path: shown.startsWith(root) ? shown.slice(root.length) : shown, title: basename(shown) };
    }
    const end = found && boundSession ? callEnd(found.row, boundSession, false) : undefined;
    const call = found && boundSession && !found.row.output ? { tool: callTool(found.row, boundSession),
      label: callText(found.row, boundSession).text + (found.row.count > 1 ? ` · ${found.row.count} 次` : ''), ...(end?.kind === 'failed' ? { word: end.word } : {}) } : undefined;
    const action = detailOpening.then(async () => {
      if (disposed || !boundSession || session !== boundSession || observer !== boundObserver) return;
      if (target && await openTarget(target)) return;
      if (!snapshot || !(snapshot.items ?? [snapshot.item]).some(hasReadableEvidence)) return;
      const { item, items } = snapshot;
      const column = detailColumn();
      if (!preview) {
        const panel = vscode.window.createWebviewPanel('agentSidecar.evidence', '证据预览',
          { viewColumn: column, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
        const view: EvidenceView = { panel, item: structuredClone(item), ...(items ? { items: structuredClone(items) } : {}), provider: boundSession.provider, kept: false, ...(change ? { change } : {}), ...(call ? { call } : {}) };
        preview = view;
        evidence.add(view);
        panel.onDidDispose(() => { evidence.delete(view); if (preview === view) preview = undefined; }, null, context.subscriptions);
        panel.webview.onDidReceiveMessage((message: unknown) => {
          const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined;
          if (type === 'keep' && preview === view) keepEvidence();
          // The file's change before or after this one in the turn, as < > in the terminal.
          else if ((type === 'olderEdit' || type === 'newerEdit') && view.change) {
            const index = Math.max(0, Math.min(view.change.steps.length - 1, view.change.index + (type === 'olderEdit' ? -1 : 1)));
            if (index !== view.change.index) { view.change.index = index; renderEvidence(view); }
          }
        }, null, context.subscriptions);
      } else { preview.item = structuredClone(item); preview.items = items ? structuredClone(items) : undefined; preview.provider = boundSession.provider; preview.change = change; preview.call = call; preview.panel.reveal(column, true); }
      renderEvidence(preview);
    });
    detailOpening = action.catch(() => undefined);
    return action;
  }
  function keepEvidence() {
    if (!preview) return;
    const kept = preview;
    kept.kept = true;
    kept.panel.title = `已保留 · ${kept.change?.title ?? kept.call?.label ?? kept.item.title}`;
    preview = undefined;
    // Confirm the state in place: do not destroy the reader's DOM or scroll position.
    void Promise.resolve(kept.panel.webview.postMessage({ type: 'kept' })).catch(reportError);
  }
  function coverageUri(snapshot: SessionData): vscode.Uri {
    return vscode.Uri.parse(`agent-sidecar-coverage:/${encodeURIComponent(snapshot.provider + '-' + snapshot.id)}.json`);
  }
  function updateCoverageDocument(snapshot: SessionData): vscode.Uri {
    const uri = coverageUri(snapshot);
    // Metadata ledger only. Never copy raw tool output, instructions, or image bytes into reports.
    coverageDocuments.set(uri.toString(), JSON.stringify({ provider: snapshot.provider, sessionId: snapshot.id,
      warnings: snapshot.warnings, coverage: snapshot.coverage,
      presentation: { note: '解析覆盖与呈现去向分开记录；同一会话的回合连续排列，左侧目录用于定位，动作详情按原始来源逐条核对。', items: outlineCoverage(snapshot) } }, null, 2));
    coverageChanged.fire(uri);
    return uri;
  }
  async function showCoverage() {
    const snapshot = session;
    if (!snapshot) return;
    const column = detailColumn();
    const uri = updateCoverageDocument(snapshot);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (disposed || session !== snapshot) return;
    await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: true, preview: false });
  }
  context.subscriptions.push(coverageChanged);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('agent-sidecar-coverage', {
    onDidChange: coverageChanged.event,
    provideTextDocumentContent: uri => coverageDocuments.get(uri.toString()) ?? 'Coverage is not loaded for this source.'
  }));
  const commands: Array<[string, () => Promise<unknown> | void]> = [
    ['agentSidecar.open', openObserver], ['agentSidecar.chooseSession', chooseSession],
    ['agentSidecar.refresh', refresh], ['agentSidecar.keepEvidence', keepEvidence], ['agentSidecar.coverage', showCoverage]
  ];
  for (const [name, handler] of commands) context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { return await handler(); } catch (error) { await reportError(error); }
  }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(observerType, {
    async resolveWebviewView(view) {
      const token = ++generation;
      try {
        attachObserver(view);
        resolved?.(); resolved = undefined;
        if (workspaceGap()) return;
        await scan();
        const key = context.workspaceState.get<string>('selectedSession');
        if (key && token === generation) await selectSession(key, token);
      } catch (error) { resolved?.(); resolved = undefined; await reportError(error); }
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    ++generation; ++scanGeneration;
    stopObservation();
    if (!observer) return;
    // VS Code normally reloads on first-folder changes. Do not keep the old
    // source alive if a workspace changes without a reload.
    if (gapShown && !workspaceGap()) { session = undefined; candidate = undefined; }
    if (gapShown || workspaceGap()) renderObserver();
    else void Promise.resolve(observer.webview.postMessage({ type: 'workspaceChanged' })).catch(() => undefined);
  }));
  context.subscriptions.push({ dispose() { disposed = true; ++generation; ++scanGeneration; stopObservation(); for (const view of evidence) view.panel.dispose(); } });

  /** Shows this window's current session, unless the reader chose another one. */
  function followCurrent(): Promise<void> {
    if (following) return following;
    following = (async () => {
      const current = currentSession(states, process.pid);
      currentKey = current ? `${current.provider}:${current.session}` : undefined;
      if (follow && current && observer && !disposed && !workspaceGap() && (!candidate || sessionKey(candidate) !== currentKey)
        // Only this project's sessions, and only once the agent has written a transcript.
        && current.transcript && existsSync(current.transcript)) {
        const project = await realpath(projectPath()).catch(() => undefined);
        const cwd = await realpath(current.cwd).catch(() => current.cwd);
        if (project && cwd === project && !disposed && follow) {
          if (!candidates.some(item => sessionKey(item) === currentKey))
            candidates = [...candidates, { id: current.session, provider: current.provider, file: current.transcript, projectPath: project, updatedAt: Date.now(), activity: 'unverified' }];
          await selectSession(currentKey!);
        }
      }
      postFollowState();
    })().finally(() => { following = undefined; });
    return following;
  }
  /** Suggests the integration while an active session has no state from it. */
  function updateHint() {
    const snapshot = session, recent = snapshot && lastRecordAt(snapshot);
    const show = !context.globalState?.get<boolean>('integrationHintDismissed') && !gapShown && Boolean(snapshot)
      && recent !== undefined && Date.now() - recent < 10 * 60 * 1000
      && !states.some(state => state.provider === snapshot!.provider && state.session === snapshot!.id);
    if (show === hintShown) return;
    hintShown = show;
    if (observer && !disposed) void Promise.resolve(observer.webview.postMessage({ type: 'integrationHint', show })).catch(() => undefined);
  }
  async function dismissHint() {
    await context.globalState?.update('integrationHintDismissed', true);
    updateHint();
  }
  async function refreshStates(): Promise<void> {
    if (disposed) return;
    states = await readSessionStates(stateDirectory, undefined, stateCache);
    if (disposed) return;
    await followCurrent();
    // A new approval or a draft changes the view without a new transcript record.
    if (live && liveView && JSON.stringify(liveExtras(live.session)) !== publishedExtras) publish();
    updateHint();
  }
  let stateWatcher: FSWatcher | undefined;
  let stateNudge: ReturnType<typeof setTimeout> | undefined;
  const nudgeStates = () => { clearTimeout(stateNudge); stateNudge = setTimeout(() => void refreshStates().catch(() => undefined), 100); };
  const watchStates = () => {
    if (stateWatcher || disposed) return;
    try {
      stateWatcher = watch(stateDirectory, nudgeStates);
      stateWatcher.on('error', () => { stateWatcher?.close(); stateWatcher = undefined; });
    } catch { /* Not created yet: the poll retries. */ }
  };
  // The watcher is fast but not guaranteed; the poll also notices an agent that exits.
  const statePoll = setInterval(() => { watchStates(); void refreshStates().catch(() => undefined); }, 1000);
  watchStates();
  context.subscriptions.push({ dispose() { clearInterval(statePoll); clearTimeout(stateNudge); stateWatcher?.close(); stateWatcher = undefined; } });

  // Test access calls the same production functions; no fixture Agent surface is part of the product.
  return { openObserver, scan, selectSession, refresh, openDetail, keepEvidence, refreshStates,
    get following() { return follow; }, get currentKey() { return currentKey; },
    get session() { return session; }, get candidates() { return [...candidates]; },
    get observer() { return observer; }, get preview() { return preview; },
    get evidence() { return [...evidence]; } };
}
