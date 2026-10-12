import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { groupSessionTurns } from '../../packages/core/src/timeline';
import { actionRows, actionRowSections, hasReadableEvidence, outlineTurn } from '../../packages/core/src/outline';

export async function run() {
  const result: any = { kind: 'product-extension-host-with-synthetic-records', vscode: vscode.version,
    startedAt: new Date().toISOString(), passed: false, checks: [], limitations: [
      'Real Codex/Claude extension coexistence is NOT verified by this fixture editor.',
      'DOM keyboard focus, sidebar pixel width, restart restoration, live discovery, and real source content require separate evidence.',
      'Semantic action rows are opened through the product host API using synthetic source records; this does not exercise a DOM click or prove the visual layout.',
      'Source disclosure is checked in generated detail HTML; native disclosure toggling requires separate DOM evidence.'
    ] };
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));
  const waitForDisposedEvidence = async () => {
    const deadline = Date.now() + 3000;
    while (vscode.window.tabGroups.all.some(group => group.viewColumn !== 1 && group.tabs.length) && Date.now() < deadline) await settle();
    // Preserve the caller's strict empty-tab assertion after waiting for the
    // asynchronous extension-host -> workbench dispose acknowledgement.
  };
  const snapshot = () => vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, active: group.isActive,
    tabs: group.tabs.map(tab => ({ label: tab.label, viewType: (tab.input as any)?.viewType, uri: (tab.input as any)?.uri?.toString() })) }));
  const check = async (name: string, action: () => Promise<void>) => {
    try { await action(); result.checks.push({ name, passed: true, groups: snapshot() }); }
    catch (error) { result.checks.push({ name, passed: false, error: String(error), groups: snapshot() }); throw error; }
  };
  try {
    const extension = vscode.extensions.getExtension('zchan0.tickbird');
    assert.ok(extension);
    const api = await extension.activate();
    const placeholder = await vscode.workspace.openTextDocument(join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'AGENT_PLACEHOLDER.txt'));
    await vscode.window.showTextDocument(placeholder, { preview: false });
    await settle();
    const editorLayout = () => snapshot().map(group => ({ column: group.column, tabs: group.tabs.map(tab => tab.label) }));
    await check('the Tickbird opens as a sidebar view without adding, locking or resizing any editor group', async () => {
      const before = editorLayout();
      assert.equal(api.observer, undefined);
      await api.openObserver(); await settle();
      assert.ok(api.observer, 'The sidebar view resolved');
      assert.equal(api.observer.visible, true);
      assert.deepEqual(editorLayout(), before, 'Editor groups and their tabs are exactly as they were');
      assert.ok(!snapshot().some(group => group.tabs.some(tab => /tickbird/.test(tab.viewType ?? ''))), 'No Tickbird editor tab exists');
    });
    await check('another editor opened into the active column cannot cover the sidebar Tickbird', async () => {
      // The reported bug: extensions that open into the active column used to land
      // in the Tickbird's own locked group. A sidebar view has no group to land in.
      const doc = await vscode.workspace.openTextDocument({ content: 'Opened into the active column', language: 'plaintext' });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: true });
      await settle();
      assert.equal(api.observer.visible, true);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); await settle();
    });
    await check('both real parsers load project fixture sessions with stable binding', async () => {
      await api.scan();
      assert.equal(api.candidates.length, 2);
      await api.selectSession('codex:cx-fixture');
      assert.equal(api.session.id, 'cx-fixture');
      await api.refresh();
      assert.equal(api.session.id, 'cx-fixture');
      assert.ok(api.session.items.some((item: any) => item.detail));
    });
    const available = () => api.session.items.filter((item: any) => item.detail && ['available', 'partial'].includes(item.availability));
    let previewColumn: vscode.ViewColumn | undefined;
    await check('the preview opens in the editor area without changing groups and is reused', async () => {
      const groups = vscode.window.tabGroups.all.length;
      const items = available(); assert.ok(items.length >= 2);
      await api.openDetail(items[0].id); await settle();
      previewColumn = api.preview.panel.viewColumn;
      assert.equal(previewColumn, 1, 'The only editor group');
      assert.equal(vscode.window.tabGroups.all.length, groups);
      assert.equal(api.observer.visible, true);
      const panel = api.preview.panel;
      await api.openDetail(items[1].id); await settle();
      assert.equal(api.preview.panel, panel);
      assert.equal(api.preview.item.id, items[1].id);
      assert.equal(api.evidence.length, 1);
    });
    await check('Keep snapshots evidence while next tool/patch preview replaces only the temporary view', async () => {
      const kept = api.preview; const snapshot = JSON.stringify(kept.item);
      api.keepEvidence(); assert.equal(api.preview, undefined);
      for (const item of available()) await api.openDetail(item.id);
      await settle();
      assert.equal(api.evidence.length, 2);
      assert.equal(JSON.stringify(kept.item), snapshot);
      assert.equal(kept.kept, true);
      assert.notEqual(api.preview.panel, kept.panel);
      assert.equal(api.preview.panel.viewColumn, previewColumn);
    });
    await check('static items do not create an empty detail or replace evidence', async () => {
      const preview = api.preview;
      await api.openDetail('missing-id');
      assert.equal(api.preview, preview);
    });
    const semanticRows = () => groupSessionTurns(api.session).flatMap(turn => outlineTurn(turn).nodes
      .flatMap(node => node.kind === 'actions' ? actionRows(node) : [])).filter(row => row.items.some(hasReadableEvidence));
    const htmlText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const assertRightEvidenceFocus = async () => {
      // Public host observations only: not DOM focus or pixel geometry.
      // A new panel reports its column only once the workbench has placed it.
      const placed = Date.now();
      while (api.preview.panel.viewColumn === undefined && Date.now() - placed < 2000) await new Promise(resolve => setTimeout(resolve, 50));
      for (let index = 0; index < 3; index++) {
        if (index) await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(api.preview.panel.viewColumn, previewColumn);
        assert.equal(api.observer.visible, true);
      }
    };
    await check('trial folded-directory and result row IDs resolve to their exact original records in the same preview', async () => {
      const displayed = groupSessionTurns(api.session).flatMap(turn => outlineTurn(turn).nodes.flatMap(node =>
        node.kind === 'actions' ? actionRowSections(node).flatMap(section => section.rows) : []))
        .filter(row => row.items.some(hasReadableEvidence));
      assert.ok(displayed.length >= 2);
      const panel = api.preview.panel;
      const count = api.evidence.length;
      const originalSnapshot = JSON.stringify(api.session.items);
      for (const row of displayed) {
        assert.match(row.id, /^(display-action-row|action-result):/);
        await api.openDetail(row.id);
        assert.equal(api.preview.panel, panel);
        assert.equal(api.preview.item.id, row.id);
        assert.deepEqual(api.preview.items, row.items);
        assert.equal(api.evidence.length, count);
      }
      await assertRightEvidenceFocus();
      assert.equal(JSON.stringify(api.session.items), originalSnapshot);
    });
    await check('semantic row IDs open their named evidence and original source snapshots in one preview via host API', async () => {
      const rows = semanticRows(); assert.ok(rows.length >= 2, 'Fixture must expose at least two semantic rows.');
      const originalSnapshot = JSON.stringify(api.session.items);
      const panel = api.preview.panel; const evidenceCount = api.evidence.length;
      for (const row of rows.slice(0, 2)) {
        assert.ok(row.id.startsWith('action-row:'));
        assert.ok(!api.session.items.some((item: any) => item.id === row.id), 'Exercise the semantic ID resolver, not an original item ID.');
        await api.openDetail(row.id);
        await assertRightEvidenceFocus();
        assert.equal(api.preview.panel, panel);
        assert.equal(api.preview.item.id, row.id);
        assert.equal(api.preview.item.title, row.description.label);
        const title = [row.description.toolName, row.description.label].filter(Boolean).join(' · ');
        assert.equal(api.preview.item.detail.title, title);
        assert.equal(api.preview.panel.webview.html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1], htmlText(title));
        assert.deepEqual(api.preview.items, row.items);
        assert.notEqual(api.preview.items, row.items);
        row.items.forEach((item, index) => {
          assert.notEqual(api.preview.items[index], item, 'Preview must own a snapshot rather than a live source item.');
          assert.ok(api.preview.panel.webview.html.includes(`data-source-item-id="${htmlText(item.id)}"`));
        });
        assert.equal(api.evidence.length, evidenceCount);
      }
      assert.equal(JSON.stringify(api.session.items), originalSnapshot);
    });
    await check('Keep preserves semantic header and original item snapshots across later row previews and fixture refresh', async () => {
      const kept = api.preview;
      assert.ok(kept.item.id.startsWith('action-row:'));
      assert.ok(kept.items?.length);
      const preserved = JSON.stringify({ item: kept.item, items: kept.items, provider: kept.provider });
      const preservedHtml = kept.panel.webview.html;
      const previousCount = api.evidence.length;
      api.keepEvidence();
      assert.equal(api.preview, undefined);
      assert.equal(kept.kept, true);
      assert.equal(kept.panel.title, `已保留 · ${kept.item.title}`);
      await api.refresh();
      let replacement: vscode.WebviewPanel | undefined;
      for (const row of semanticRows().slice(0, 2)) {
        await api.openDetail(row.id);
        await assertRightEvidenceFocus();
        assert.notEqual(api.preview.panel, kept.panel);
        if (replacement) assert.equal(api.preview.panel, replacement);
        else replacement = api.preview.panel;
        assert.equal(api.preview.item.id, row.id);
        assert.deepEqual(api.preview.items, row.items);
        assert.equal(api.evidence.length, previousCount + 1);
        assert.equal(JSON.stringify({ item: kept.item, items: kept.items, provider: kept.provider }), preserved);
        assert.equal(kept.panel.webview.html, preservedHtml);
      }
    });
    await check('compact detail retains source disclosures and original record snapshots through Keep without changing layout', async () => {
      const row = semanticRows().find(row => row.items.some(item => item.detail?.provenance));
      assert.ok(row, 'Fixture must include source-backed evidence with provenance.');
      const sourceSnapshot = JSON.stringify(api.session.items);
      await api.openDetail(row.id);
      await assertRightEvidenceFocus();
      const view = api.preview;
      const html = view.panel.webview.html as string;
      const before = JSON.stringify({ item: view.item, items: view.items, provider: view.provider });
      const groupsBefore = snapshot();
      const disclosures = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)]
        .filter(match => /\bdata-evidence-source\b/.test(match[1]));
      assert.ok(disclosures.length, 'Precise source information remains in a native disclosure, not removed from the page.');
      assert.ok(disclosures.every(match => !/\bopen(?:\s|=|$)/.test(match[1])), 'Source metadata starts collapsed.');
      assert.ok(disclosures.every(match => match[2].includes('class="source-list"')));
      assert.deepEqual(view.items, row.items);
      let previousRecord = -1;
      for (const original of row.items) {
        const recordPosition = html.indexOf(`data-source-item-id="${htmlText(original.id)}"`);
        assert.ok(recordPosition > previousRecord, 'Original record order is preserved.');
        previousRecord = recordPosition;
        for (const source of original.sources) {
          assert.ok(disclosures.some(match => match[2].includes(htmlText(`${source.file}:${source.line}`))));
        }
        if (original.detail?.provenance) assert.ok(disclosures.some(match => match[2].includes(htmlText(original.detail!.provenance!))));
      }
      api.keepEvidence();
      assert.equal(api.preview, undefined);
      assert.equal(view.kept, true);
      assert.equal(view.panel.webview.html, html, 'Keep does not replace the DOM containing the disclosure.');
      assert.equal(JSON.stringify({ item: view.item, items: view.items, provider: view.provider }), before);
      assert.deepEqual(snapshot().map(group => [group.column, group.active]), groupsBefore.map(group => [group.column, group.active]));
      await api.openDetail(row.items[0].id);
      await assertRightEvidenceFocus();
      assert.notEqual(api.preview.panel, view.panel);
      assert.equal(JSON.stringify({ item: view.item, items: view.items, provider: view.provider }), before);
      assert.equal(view.panel.webview.html, html);
      assert.equal(JSON.stringify(api.session.items), sourceSnapshot);
    });
    await check('Claude parser reaches the same editor-area evidence path after explicit detail closure', async () => {
      for (const view of api.evidence) view.panel.dispose();
      await settle();
      await api.selectSession('claude:cl-fixture');
      assert.equal(api.session.id, 'cl-fixture');
      const item = available().find((item: any) => item.kind === 'tool'); assert.ok(item);
      await api.openDetail(item.id); await settle();
      assert.equal(api.preview.provider, 'claude');
      assert.equal(api.observer.visible, true);
    });
    for (const provider of ['claude', 'codex'] as const) await check(`${provider} append is observed automatically and posted without replacing Webview HTML or evidence`, async () => {
      for (const view of api.evidence) view.panel.dispose();
      await settle();
      await api.selectSession(provider === 'claude' ? 'claude:cl-fixture' : 'codex:cx-fixture');
      const source = api.candidates.find((candidate: any) => candidate.provider === provider);
      assert.ok(source && source.file.startsWith(process.env[provider === 'codex' ? 'TICKBIRD_TEST_CODEX_ROOT' : 'TICKBIRD_TEST_CLAUDE_ROOT']!), 'Append only to this run\'s synthetic fixture');
      const item = available()[0]; await api.openDetail(item.id); api.keepEvidence();
      const kept = api.evidence[0], keptSnapshot = JSON.stringify(kept.item), keptHtml = kept.panel.webview.html;
      const webview = api.observer.webview as vscode.Webview;
      const originalHtml = webview.html, originalPost = webview.postMessage.bind(webview);
      const deliveries: any[] = [];
      webview.postMessage = message => { deliveries.push(message); return originalPost(message); };
      const before = snapshot().map(group => [group.column, group.active]);
      const marker = `Synthetic live ${provider} append`;
      const record = provider === 'codex' ? { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: marker }] } }
        : { type: 'assistant', uuid: 'live-host-message', sessionId: 'cl-fixture', message: { role: 'assistant', content: [{ type: 'text', text: marker }] } };
      const appendedAt = Date.now();
      try {
        await appendFile(source.file, JSON.stringify(record) + '\n');
        while (!deliveries.some(message => message.type === 'observation' && message.turns.some((turn: any) => turn.html.includes(marker))) && Date.now() - appendedAt < 10000) await new Promise(resolve => setTimeout(resolve, 50));
        const delivered = deliveries.find(message => message.type === 'observation' && message.turns.some((turn: any) => turn.html.includes(marker)));
        assert.ok(delivered, 'Automatic production poll reaches the Webview bridge without Refresh');
        result.liveDelivery ??= []; result.liveDelivery.push({ provider, appendToHostPostObservedMs: Date.now() - appendedAt, changedTurns: delivered.turns.length });
        assert.equal(webview.html, originalHtml, 'The document was not regenerated');
        assert.equal(JSON.stringify(kept.item), keptSnapshot); assert.equal(kept.panel.webview.html, keptHtml);
        assert.deepEqual(snapshot().map(group => [group.column, group.active]), before);
      } finally { webview.postMessage = originalPost; }
    });
    await check('the window follows the session the integration says is its current one, and shows what it waits for', async () => {
      // A state file as the integration hook writes it, naming this extension host as the window.
      const directory = join(process.env.XDG_STATE_HOME!, 'tickbird', 'sessions');
      assert.ok(directory.startsWith(process.env.XDG_STATE_HOME!) && process.env.XDG_STATE_HOME!.includes('sidecar-product-host-'), 'Only this run\'s state directory');
      const claude = api.candidates.find((candidate: any) => candidate.provider === 'claude');
      await api.selectSession('codex:cx-fixture');
      assert.equal(api.session.id, 'cx-fixture');
      const webview = api.observer.webview as vscode.Webview, originalPost = webview.postMessage.bind(webview);
      const deliveries: any[] = [];
      webview.postMessage = message => { deliveries.push(message); return originalPost(message); };
      try {
        mkdirSync(directory, { recursive: true });
        const file = join(directory, 'claude-cl-fixture.jsonl');
        const line = (record: object) => appendFile(file, JSON.stringify({ v: 1, t: Date.now(), ...record }) + '\n');
        await line({ e: 'start', provider: 'claude', session: 'cl-fixture', transcript: claude.file, cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
          agentPid: process.pid, hostPid: process.pid, source: 'startup' });
        const until = async (done: () => boolean, what: string) => {
          const deadline = Date.now() + 8000;
          while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
          assert.ok(done(), what);
        };
        await until(() => api.session?.id === 'cl-fixture', 'Followed the window\'s current session');
        await line({ e: 'approval', tool: 'Write', summary: '/fixture/numbers.txt' });
        await until(() => deliveries.some(message => message.type === 'observation' && message.turns.some((turn: any) => turn.html.includes('Needs approval') && turn.html.includes('<b>Write</b> · numbers.txt'))),
          'The approval reached the newest turn');
        // The agent moved on: a newer transcript record answers the approval (the hooks report no turns).
        await appendFile(claude.file, JSON.stringify({ type: 'assistant', uuid: 'host-after-approval', sessionId: 'cl-fixture', timestamp: new Date(Date.now() + 1).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Approval handled.' }] } }) + '\n');
        await until(() => deliveries.filter(message => message.type === 'observation').at(-1)?.turns.every((turn: any) => !turn.html.includes('Needs approval')), 'The answered approval is gone');
        result.followDelivery = { observations: deliveries.filter(message => message.type === 'observation').length };
      } finally { webview.postMessage = originalPost; }
    });
    result.passed = true;
  } catch (error) { result.error = String(error); throw error; }
  finally {
    result.finishedAt = new Date().toISOString();
    if (process.env.TICKBIRD_TEST_RESULT) writeFileSync(process.env.TICKBIRD_TEST_RESULT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.map((check: any) => ({ name: check.name, passed: check.passed })) }));
  }
}
