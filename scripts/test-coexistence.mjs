import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentExtensions = [
  { id: 'openai.chatgpt', version: '26.901.22334', directory: 'openai.chatgpt-26.901.22334-darwin-arm64', command: 'chatgpt.newCodexPanel' },
  { id: 'Anthropic.claude-code', version: '2.1.261', directory: 'anthropic.claude-code-2.1.261-darwin-arm64', command: 'claude-vscode.editor.open' },
];
for (const extension of agentExtensions) {
  extension.path = join(homedir(), '.vscode', 'extensions', extension.directory);
  const manifest = JSON.parse(await readFile(join(extension.path, 'package.json'), 'utf8'));
  if (`${manifest.publisher}.${manifest.name}` !== extension.id || manifest.version !== extension.version ||
      !manifest.contributes?.commands?.some(value => value.command === extension.command)) {
    throw new Error(`Installed extension does not match the reviewed public entry: ${extension.id}`);
  }
}
await access(join(root, 'dist', 'tests', 'host', 'coexistence.js'));
const runRoot = await mkdtemp(join(tmpdir(), 'sidecar-coexistence-'));
const userData = join(runRoot, 'user-data');
const extensions = join(runRoot, 'extensions');
await Promise.all([mkdir(join(userData, 'User'), { recursive: true }), mkdir(extensions)]);
await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
  'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
  'workbench.editor.closeEmptyGroups': true, 'security.workspace.trust.enabled': false,
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
  'chatgpt.openOnStartup': false, 'claudeCode.useTerminal': false,
}));
const resultFile = join(runRoot, 'result.json');
const code = process.env.SIDECAR_CODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const args = ['--new-window', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${root}`, ...agentExtensions.map(extension => `--extensionDevelopmentPath=${extension.path}`),
  `--extensionTestsPath=${join(root, 'dist/tests/host/coexistence.js')}`, root];
const childEnvironment = { ...process.env, SIDECAR_COEXISTENCE_RESULT: resultFile, SIDECAR_COEXISTENCE_PROJECT: root };
// Production source discovery only. Do not copy profile state, secrets or Agent credential files.
delete childEnvironment.SIDECAR_TEST_CODEX_ROOT;
delete childEnvironment.SIDECAR_TEST_CLAUDE_ROOT;
delete childEnvironment.SIDECAR_TEST_RESULT;
const child = spawn(code, args, { stdio: 'inherit', env: childEnvironment });
console.log(JSON.stringify({ runRoot, resultFile, launcherPid: child.pid, agentExtensions: agentExtensions.map(({ id, version }) => ({ id, version })) }));
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
let result;
const deadline = Date.now() + 60000;
while (!result && Date.now() < deadline) {
  try { result = JSON.parse(await readFile(resultFile, 'utf8')); }
  catch { await new Promise(resolve => setTimeout(resolve, 200)); }
}
const artifact = join(root, '.test-artifacts', 'coexistence-latest.json');
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, JSON.stringify(result ? { ...result, runRoot, launcherExitCode: exitCode,
  isolation: { userData, extensionsDirectory: extensions, installedExtensionCodeReadOnly: true, credentialFilesCopied: false } } : {
  kind: 'real-extensions-coexistence-public-host-api', passed: false, authoritativeHostResult: false,
  error: 'No authoritative host result was produced; no coexistence verification is claimed.', runRoot, launcherExitCode: exitCode,
}, null, 2) + '\n');
console.log(JSON.stringify({ passed: result?.passed ?? false, checks: result?.checks?.map(value => ({ name: value.name, passed: value.passed })), artifact }, null, 2));
process.exitCode = result?.passed ? 0 : 1;
