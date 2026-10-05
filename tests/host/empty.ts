import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** A window with no folder: the restored sidebar view must explain itself, not warn and stay blank. */
export async function run() {
  const result: any = { kind: 'product-extension-host-empty-window', vscode: vscode.version,
    startedAt: new Date().toISOString(), passed: false, checks: [], limitations: [
      'Warnings are intercepted through this test file\'s vscode API object; the webview click on 打开文件夹… is not exercised.'
    ] };
  const settle = () => new Promise(resolve => setTimeout(resolve, 200));
  const warnings: string[] = [];
  const originalWarning = vscode.window.showWarningMessage;
  (vscode.window as any).showWarningMessage = (message: string, ...rest: unknown[]) => { warnings.push(message); return (originalWarning as any)(message, ...rest); };
  const check = async (name: string, action: () => Promise<void>) => {
    try { await action(); result.checks.push({ name, passed: true }); }
    catch (error) { result.checks.push({ name, passed: false, error: String(error) }); throw error; }
  };
  try {
    const extension = vscode.extensions.getExtension('zchan0.agent-sidecar');
    assert.ok(extension);
    const api = await extension.activate();
    await check('an empty window opens the sidebar view with its reason and an Open Folder action', async () => {
      assert.equal(vscode.workspace.workspaceFolders, undefined, 'This window has no folder');
      await api.openObserver(); await settle();
      assert.ok(api.observer, 'The sidebar view resolved');
      const html: string = api.observer.webview.html;
      assert.match(html, /data-workspace-gap="empty"/);
      assert.ok(html.includes('打开一个项目文件夹'));
      assert.ok(html.includes('data-action="openFolder"'));
      assert.deepEqual(warnings, []);
    });
    await check('choose and refresh commands land on the same explanation without a warning', async () => {
      await vscode.commands.executeCommand('agentSidecar.chooseSession');
      await vscode.commands.executeCommand('agentSidecar.refresh'); await settle();
      assert.match(api.observer.webview.html, /data-workspace-gap="empty"/);
      assert.equal(api.session, undefined);
      assert.deepEqual(warnings, []);
    });
    result.passed = true;
  } catch (error) { result.error = String(error); throw error; }
  finally {
    (vscode.window as any).showWarningMessage = originalWarning;
    result.warnings = warnings;
    result.finishedAt = new Date().toISOString();
    if (process.env.SIDECAR_TEST_RESULT) writeFileSync(process.env.SIDECAR_TEST_RESULT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks.map((check: any) => ({ name: check.name, passed: check.passed })) }));
  }
}
