import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { SessionCandidate, SessionData, TimelineItem } from '../../packages/core/src/model';

interface EvidenceView { panel: vscode.WebviewPanel; item: TimelineItem; provider: string; kept: boolean }
interface SidecarApi {
  openObserver(): Promise<void>; scan(): Promise<unknown>; selectSession(key: string): Promise<void>;
  openDetail(id: string): Promise<void>; keepEvidence(): void;
  readonly candidates: SessionCandidate[]; readonly session: SessionData | undefined;
  readonly observer: vscode.WebviewPanel | undefined; readonly preview: EvidenceView | undefined;
  readonly evidence: EvidenceView[];
}
const agents = [
  { id: 'openai.chatgpt', version: '26.901.22334', command: 'chatgpt.newCodexPanel' },
  { id: 'Anthropic.claude-code', version: '2.1.261', command: 'claude-vscode.editor.open' },
] as const;
const samples = [
  { name: 'CX1', provider: 'codex', id: '01a00000-0000-7000-8000-0000000000c1' },
  { name: 'CX2', provider: 'codex', id: '01a00000-0000-7000-8000-0000000000c2' },
  { name: 'CL1', provider: 'claude', id: '00000000-0000-4000-8000-0000000000a1' },
  { name: 'CL2', provider: 'claude', id: '00000000-0000-4000-8000-0000000000a3' },
] as const;

export async function run() {
  const result: Record<string, any> = {
    kind: 'real-extensions-coexistence-public-host-api', vscode: vscode.version,
    startedAt: new Date().toISOString(), passed: false, checks: [], extensions: [], samples: [], focusObservations: [],
    authorizationBoundary: 'Only public no-argument UI-opening commands and read-only Sidecar APIs; no prompt, login, approval or Agent execution requested.',
    sourceScope: 'Production discovery in the real project; current on-disk session snapshots, NOT the frozen prefixes of earlier sample audits.',
    setup: 'The test joins only its isolated window\'s newly opened Agent tabs into one editor group before Sidecar inserts its own group.',
    limitations: [
      'New Agent webview tabs are real extension surfaces, but their content is NOT inspected; they may be login, onboarding or empty-conversation screens.',
      'The original Agent UI for CX1/CX2/CL1/CL2 is NOT opened or verified. Sidecar selection does not imply original-chat session binding.',
      'Public tabGroups/WebviewPanel evidence does NOT verify DOM focus, screenshots, pixel widths or individual original-chat content.',
      'Starting an extension may start its normal backend; this test submits no Agent task and does not establish that extension activation is free of background activity.',
      'Live discovery reads local identity metadata; the selected records may change while this test runs. No raw conversation text, image bytes or credentials are written to this report.',
    ],
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 20000;
    while (!condition() && Date.now() < deadline) await pause();
    assert.ok(condition(), message);
  };
  // Codex uses a public TabInputCustom; Claude uses a public TabInputWebview.
  const webviewType = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputWebview || tab.input instanceof vscode.TabInputCustom ? tab.input.viewType : undefined;
  const webviewTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => webviewType(tab));
  const snapshot = () => vscode.window.tabGroups.all.map(group => ({
    column: group.viewColumn, active: group.isActive,
    tabs: group.tabs.map(tab => ({ viewType: webviewType(tab) ?? null,
      inputKind: tab.input instanceof vscode.TabInputCustom ? 'custom-editor' : tab.input instanceof vscode.TabInputWebview ? 'webview' : 'other',
      active: tab.isActive, pinned: tab.isPinned, preview: tab.isPreview })),
  }));
  const check = async (name: string, action: () => Promise<void>, fatal = true) => {
    try { await action(); result.checks.push({ name, passed: true, groups: snapshot() }); }
    catch (error) { result.checks.push({ name, passed: false, error: String(error), groups: snapshot() }); if (fatal) throw error; }
  };
  let api: SidecarApi | undefined;
  try {
    assert.equal(process.env.SIDECAR_TEST_CODEX_ROOT, undefined, 'Real-source test must not use Codex fixture overrides');
    assert.equal(process.env.SIDECAR_TEST_CLAUDE_ROOT, undefined, 'Real-source test must not use Claude fixture overrides');
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(vscode.workspace.workspaceFolders?.[0].uri.fsPath, process.env.SIDECAR_COEXISTENCE_PROJECT);
    const sidecar = vscode.extensions.getExtension<SidecarApi>('zchan0.agent-sidecar');
    assert.ok(sidecar);
    api = await sidecar.activate();
    const ownApi = api;
    const realTypes = new Set<string>();
    for (const target of agents) {
      await check(`public command opens real ${target.id} ${target.version} editor surface`, async () => {
        const extension = vscode.extensions.getExtension(target.id);
        assert.ok(extension, `Missing development-loaded extension: ${target.id}`);
        assert.equal(extension.packageJSON.version, target.version);
        assert.ok(extension.packageJSON.contributes?.commands?.some((value: { command: string }) => value.command === target.command));
        await extension.activate();
        const before = new Set(webviewTabs());
        // Intentionally no arguments: never pass prompt, session resume, approval or execution data.
        await vscode.commands.executeCommand(target.command);
        await waitFor(() => webviewTabs().some(tab => !before.has(tab)), `${target.command} did not add a publicly observable custom-editor or webview tab`);
        const added = webviewTabs().filter(tab => !before.has(tab));
        for (const tab of added) realTypes.add(webviewType(tab)!);
        result.extensions.push({ id: extension.id, version: extension.packageJSON.version, extensionPath: extension.extensionPath,
          command: target.command, arguments: [], activated: extension.isActive, addedViewTypes: added.map(webviewType),
          originalSessionUiVerified: false, loginOrConversationContent: 'not inspected' });
      });
    }
    await check('prepare isolated Agent tab group, then Sidecar preserves both real surfaces in the middle group', async () => {
      await vscode.commands.executeCommand('workbench.action.joinAllGroups');
      await waitFor(() => vscode.window.tabGroups.all.length === 1, 'Test-owned Agent groups did not join');
      const before = webviewTabs().map(webviewType);
      assert.ok(realTypes.size >= 2, 'Both providers must expose distinct real webview types');
      assert.ok(before.length >= 2);
      await ownApi.openObserver();
      await waitFor(() => vscode.window.tabGroups.all.length === 2, 'Sidecar did not insert its left group');
      assert.equal(ownApi.observer?.viewColumn, vscode.ViewColumn.One);
      const middle = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.Two)!;
      for (const type of before) assert.ok(middle.tabs.some(tab => webviewType(tab) === type), `Agent tab ${type} was replaced or moved out of the middle group`);
    });
    const assertAgentsPreserved = () => {
      const middle = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.Two);
      assert.ok(middle);
      for (const type of realTypes) assert.ok(middle.tabs.some(tab => webviewType(tab) === type), `Real Agent tab ${type} is no longer in the middle group`);
    };
    await check('production source discovery finds all four explicit current-project sample identities', async () => {
      await ownApi.scan();
      for (const sample of samples) assert.ok(ownApi.candidates.some(value => value.id === sample.id && value.provider === sample.provider), `Production discovery did not find ${sample.name}`);
    });
    for (const sample of samples) {
      await check(`${sample.name}: real record selection, reusable right preview and Keep preserve both Agent tabs`, async () => {
        const recordFocus = async (phase: string) => {
          // Check every operation, not just the end of the sequence where a
          // later action could conceal the previous focus loss.
          for (let index = 0; index < 3; index++) {
            if (index) await pause();
            result.focusObservations.push({ sample: sample.name, phase, elapsedSampleMs: index * 100,
              observedAt: new Date().toISOString(), observerActive: ownApi.observer?.active,
              activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, groups: snapshot() });
            assert.equal(ownApi.observer?.active, true, `${phase}: Sidecar must remain publicly active (not a DOM focus assertion)`);
            assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One, `${phase}: focus left the Sidecar group`);
          }
        };
        // Close only Sidecar-owned details before the next explicit session selection.
        for (const view of ownApi.evidence) view.panel.dispose();
        await waitFor(() => ownApi.evidence.length === 0, 'Owned details did not close');
        await waitFor(() => vscode.window.tabGroups.all.length === 2, 'The closed, test-owned detail group is still present');
        await ownApi.selectSession(`${sample.provider}:${sample.id}`);
        const selected = ownApi.session;
        assert.ok(selected);
        assert.equal(selected.id, sample.id);
        assert.equal(selected.provider, sample.provider);
        const available = selected.items.filter(item => item.detail?.blocks.length && ['available', 'partial'].includes(item.availability));
        assert.ok(available.length >= 2, `${sample.name} did not provide two nonempty detail records`);
        // Prefer execution evidence; no recorded command is executed by openDetail.
        const ordered = [...available.filter(item => ['tool', 'file-change', 'question'].includes(item.kind)), ...available];
        const items = [...new Map(ordered.map(item => [item.id, item])).values()].slice(0, 2);
        ownApi.observer!.reveal(vscode.ViewColumn.One, false);
        await waitFor(() => ownApi.observer!.active && vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One,
          'Focus precondition failed: Sidecar must be publicly active before opening evidence');
        await recordFocus('sidecar-active-before-evidence');
        await ownApi.openDetail(items[0].id);
        await waitFor(() => ownApi.preview?.panel.viewColumn === vscode.ViewColumn.Three, 'Preview did not open to the Agent group\'s right');
        await recordFocus('first-preview-opened');
        const previewPanel = ownApi.preview!.panel;
        await ownApi.openDetail(items[1].id);
        await recordFocus('preview-reused');
        assert.equal(ownApi.preview!.panel, previewPanel);
        assert.equal(ownApi.preview!.item.id, items[1].id);
        assert.equal(ownApi.evidence.length, 1);
        const kept = ownApi.preview!;
        const evidenceSnapshot = JSON.stringify(kept.item);
        ownApi.keepEvidence();
        await recordFocus('preview-kept');
        await ownApi.openDetail(items[0].id);
        assert.equal(kept.kept, true);
        assert.equal(JSON.stringify(kept.item), evidenceSnapshot);
        assert.notEqual(ownApi.preview!.panel, kept.panel);
        assert.equal(ownApi.evidence.length, 2);
        assert.equal(ownApi.preview!.provider, sample.provider);
        assert.equal(ownApi.preview!.panel.viewColumn, vscode.ViewColumn.Three);
        await waitFor(() => (vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.Three)?.tabs
          .filter(tab => webviewType(tab)?.endsWith('agentSidecar.evidence')).length ?? 0) === 2,
        'Keep and preview must be two publicly observable right-side tabs');
        await recordFocus('kept-and-preview-tabs-present');
        assert.equal(ownApi.observer!.active, true, 'Public panel.active changed; this is not a DOM-focus assertion');
        assert.equal(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One);
        assertAgentsPreserved();
        const source = ownApi.candidates.find(value => value.id === sample.id && value.provider === sample.provider)!;
        result.samples.push({ name: sample.name, provider: sample.provider, sessionId: selected.id, file: source.file,
          observedItems: selected.items.length, coverageRecords: selected.coverage.length, warningCount: selected.warnings.length,
          evidence: items.map(item => ({ id: item.id, kind: item.kind, availability: item.availability, sources: item.sources })),
          sourceSnapshot: 'current production-loaded file, not prior frozen audit prefix', originalChatCompared: false });
      }, false);
    }
    await check('public-only focus diagnostic records idle, layout, create, reveal, Keep and new-preview phases', async () => {
      for (const view of ownApi.evidence) view.panel.dispose();
      await waitFor(() => ownApi.evidence.length === 0 && vscode.window.tabGroups.all.length === 2, 'Diagnostic needs two settled groups');
      const items = ownApi.session!.items.filter(item => item.detail?.blocks.length && ['available', 'partial'].includes(item.availability)).slice(0, 2);
      assert.equal(items.length, 2);
      const observe = async (phase: string) => {
        // Identical observation windows are diagnostic sampling, not a product latency threshold.
        for (let sample = 0; sample <= 5; ++sample) {
          if (sample) await pause();
          result.focusObservations.push({ diagnostic: true, phase, elapsedSampleMs: sample * 100,
            observedAt: new Date().toISOString(), observerActive: ownApi.observer!.active,
            activeGroup: vscode.window.tabGroups.activeTabGroup.viewColumn, groups: snapshot() });
        }
      };
      ownApi.observer!.reveal(vscode.ViewColumn.One, false);
      await waitFor(() => ownApi.observer!.active && vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One, 'Diagnostic focus precondition failed');
      await observe('idle-after-observer-reveal-no-evidence-click');
      const layout = await vscode.commands.executeCommand<{ orientation: number; groups: Array<{ size?: number }> }>('vscode.getEditorLayout');
      assert.ok(layout && layout.groups.length === 2 && layout.orientation === 0);
      const side = layout.groups[0].size ?? 0.25;
      // Separate the same public host layout operation from webview creation, without instrumenting product internals.
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0, groups: [{ size: side }, { size: (1 - side) * 0.55 }, { size: (1 - side) * 0.45 }],
      });
      await observe('after-public-setEditorLayout-three-columns');
      await ownApi.openDetail(items[0].id);
      await observe('after-createWebview-in-existing-third-column');
      await ownApi.openDetail(items[1].id);
      await observe('after-reveal-existing-preview');
      ownApi.keepEvidence();
      await observe('after-Keep');
      await ownApi.openDetail(items[0].id);
      await observe('after-create-new-preview-with-kept-tab');
      assertAgentsPreserved();
      result.focusDiagnostic = { observationWindowMs: 500, samplePeriodMs: 100,
        meaning: 'Public state observations only; this check passes when the diagnostic completed, not when focus behavior is correct.' };
    }, false);
    result.passed = result.checks.every((entry: { passed: boolean }) => entry.passed);
    if (!result.passed) throw new Error('One or more independently recorded coexistence checks failed.');
  } catch (error) { result.error = String(error); throw error; }
  finally {
    result.finishedAt = new Date().toISOString();
    if (process.env.SIDECAR_COEXISTENCE_RESULT) writeFileSync(process.env.SIDECAR_COEXISTENCE_RESULT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ kind: result.kind, passed: result.passed, checks: result.checks.map((value: any) => ({ name: value.name, passed: value.passed })) }));
    for (const view of api?.evidence ?? []) view.panel.dispose();
  }
}
