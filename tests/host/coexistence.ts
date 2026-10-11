import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { SessionCandidate, SessionData, TimelineItem } from '../../packages/core/src/model';
import { callLink, fileRead, recordedImage, turnRows } from '../../packages/core/src/call-target';
import { visibleTurnGroups } from '../../packages/core/src/outline';

interface EvidenceView { panel: vscode.WebviewPanel; item: TimelineItem; provider: string; kept: boolean }
interface SidecarApi {
  openObserver(): Promise<void>; scan(): Promise<unknown>; selectSession(key: string): Promise<void>;
  openDetail(id: string): Promise<void>; keepEvidence(): void;
  readonly candidates: SessionCandidate[]; readonly session: SessionData | undefined;
  readonly observer: vscode.WebviewView | undefined; readonly preview: EvidenceView | undefined;
  readonly evidence: EvidenceView[];
}
/** The installed Agent extensions the runner loaded, and the public command each opens its editor surface with. */
const agents = [
  { id: 'openai.chatgpt', command: 'chatgpt.newCodexPanel' },
  { id: 'Anthropic.claude-code', command: 'claude-vscode.editor.open' },
] as const;

/**
 * Sidecar beside the real Claude Code and Codex extensions: it is a side bar
 * view, so opening it and its details must leave the Agents' own editor tabs
 * where they are. Samples are this project's newest sessions of each agent.
 */
export async function run() {
  const result: Record<string, any> = {
    kind: 'real-extensions-coexistence-public-host-api', vscode: vscode.version,
    startedAt: new Date().toISOString(), passed: false, checks: [], extensions: [], samples: [],
    authorizationBoundary: 'Only public no-argument UI-opening commands and read-only Sidecar APIs; no prompt, login, approval or Agent execution requested.',
    sourceScope: 'Production discovery in the real project; the newest current-project sessions of each agent at the time of the run.',
    limitations: [
      'New Agent webview tabs are real extension surfaces, but their content is NOT inspected; they may be login, onboarding or empty-conversation screens.',
      'Public tabGroups/WebviewPanel evidence does NOT verify DOM focus, screenshots or pixel widths.',
      'Starting an extension may start its normal backend; this test submits no Agent task.',
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
    tabs: group.tabs.map(tab => ({ viewType: webviewType(tab) ?? null, active: tab.isActive, preview: tab.isPreview })),
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
    // Where each Agent's own tab is: column and view type. Sidecar must not move or replace them.
    const agentTabs = new Map<string, vscode.ViewColumn>();
    for (const target of agents) {
      await check(`public command opens the real ${target.id} editor surface`, async () => {
        const extension = vscode.extensions.getExtension(target.id);
        assert.ok(extension, `Missing development-loaded extension: ${target.id}`);
        assert.ok(extension.packageJSON.contributes?.commands?.some((value: { command: string }) => value.command === target.command));
        await extension.activate();
        const before = new Set(webviewTabs());
        // Intentionally no arguments: never pass prompt, session resume, approval or execution data.
        await vscode.commands.executeCommand(target.command);
        await waitFor(() => webviewTabs().some(tab => !before.has(tab)), `${target.command} did not add a publicly observable custom-editor or webview tab`);
        const added = webviewTabs().filter(tab => !before.has(tab));
        for (const tab of added) agentTabs.set(webviewType(tab)!, tab.group.viewColumn);
        result.extensions.push({ id: extension.id, version: extension.packageJSON.version, command: target.command, arguments: [],
          activated: extension.isActive, addedViewTypes: added.map(webviewType), loginOrConversationContent: 'not inspected' });
      });
    }
    const assertAgentsPreserved = (phase: string) => {
      for (const [type, column] of agentTabs) {
        const tab = webviewTabs().find(candidate => webviewType(candidate) === type);
        assert.ok(tab, `${phase}: the Agent tab ${type} was closed or replaced`);
        assert.equal(tab.group.viewColumn, column, `${phase}: the Agent tab ${type} moved out of its group`);
      }
    };
    await check('the Sidecar side bar view opens without touching the editor groups', async () => {
      assert.ok(agentTabs.size >= 2, 'Both providers must expose distinct real webview types');
      const groups = vscode.window.tabGroups.all.length;
      await ownApi.openObserver();
      await waitFor(() => Boolean(ownApi.observer?.visible), 'The Sidecar view did not become visible');
      assert.equal(vscode.window.tabGroups.all.length, groups, 'Opening the side bar view added or removed an editor group');
      assertAgentsPreserved('after opening Sidecar');
    });
    const samples: SessionCandidate[] = [];
    await check('production source discovery finds this project\'s sessions of both agents', async () => {
      await ownApi.scan();
      for (const provider of ['codex', 'claude'] as const) {
        const newest = ownApi.candidates.filter(candidate => candidate.provider === provider).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
        assert.ok(newest.length, `Production discovery found no ${provider} session for this project`);
        samples.push(...newest);
      }
    });
    // Newest first, until two sessions of each agent are verified: recent ones may hold little.
    const verified = (provider: string) => result.samples.filter((entry: any) => entry.provider === provider && !entry.skipped).length;
    for (const sample of samples) {
      if (verified(sample.provider) >= 2) continue;
      const name = `${sample.provider}:${sample.id.slice(0, 8)}`;
      await check(`${name}: a detail opens in the editor area, the preview is reused, Keep leaves it and a new preview opens; the Agent tabs stay`, async () => {
        for (const view of ownApi.evidence) view.panel.dispose();
        await waitFor(() => ownApi.evidence.length === 0, 'Owned details did not close');
        await ownApi.selectSession(`${sample.provider}:${sample.id}`);
        const selected = ownApi.session;
        assert.ok(selected && selected.id === sample.id && selected.provider === sample.provider);
        // Calls as the panel shows them that open as a detail page: not a read, an image or a link, which open the thing itself.
        const ids = visibleTurnGroups(selected).flatMap(turnRows)
          .filter(row => row.openable && !row.output && !fileRead(selected, row) && !recordedImage(selected, row) && !callLink(selected, row))
          .map(row => row.id);
        const unique = [...new Set(ids)].slice(0, 2);
        // A session with too little in it says nothing either way.
        if (unique.length < 2) { result.samples.push({ name, provider: sample.provider, skipped: 'fewer than two calls that open as a detail page' }); return; }
        await ownApi.openDetail(unique[0]);
        await waitFor(() => Boolean(ownApi.preview), 'The detail did not open');
        const previewPanel = ownApi.preview!.panel;
        assertAgentsPreserved('first detail opened');
        await ownApi.openDetail(unique[1]);
        assert.equal(ownApi.preview!.panel, previewPanel, 'The preview is reused');
        assert.equal(ownApi.evidence.length, 1);
        const kept = ownApi.preview!;
        const evidenceSnapshot = JSON.stringify(kept.item);
        ownApi.keepEvidence();
        await ownApi.openDetail(unique[0]);
        assert.equal(kept.kept, true);
        assert.equal(JSON.stringify(kept.item), evidenceSnapshot, 'A kept page does not change');
        assert.notEqual(ownApi.preview!.panel, kept.panel);
        assert.equal(ownApi.evidence.length, 2);
        assert.equal(ownApi.preview!.provider, sample.provider);
        await waitFor(() => webviewTabs().filter(tab => webviewType(tab)?.endsWith('agentSidecar.evidence')).length === 2,
          'Keep and preview must be two publicly observable tabs');
        assertAgentsPreserved('kept and preview tabs present');
        result.samples.push({ name, provider: sample.provider, sessionId: selected.id, observedItems: selected.items.length,
          coverageRecords: selected.coverage.length, warningCount: selected.warnings.length, detailRows: unique });
      }, false);
    }
    await check('each agent had a session verified', async () => {
      for (const provider of ['codex', 'claude']) assert.ok(result.samples.some((entry: any) => entry.provider === provider && !entry.skipped), `No ${provider} session had two calls that open as a detail page`);
    });
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
