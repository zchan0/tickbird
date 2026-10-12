import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The newest installed copy of each Agent extension, as the developer window loads them; the command must still be public.
const installed = join(homedir(), '.vscode', 'extensions');
const agentExtensions = [
  { id: 'openai.chatgpt', command: 'chatgpt.newCodexPanel' },
  { id: 'Anthropic.claude-code', command: 'claude-vscode.editor.open' },
];
const found = [];
for (const directory of await readdir(installed).catch(() => [])) {
  try {
    const manifest = JSON.parse(await readFile(join(installed, directory, 'package.json'), 'utf8'));
    found.push({ path: join(installed, directory), id: `${manifest.publisher}.${manifest.name}`, version: manifest.version, commands: (manifest.contributes?.commands ?? []).map(value => value.command) });
  } catch { /* An incomplete installation. */ }
}
for (const extension of agentExtensions) {
  const latest = found.filter(item => item.id.toLowerCase() === extension.id.toLowerCase()).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!latest || !latest.commands.includes(extension.command)) throw new Error(`No installed ${extension.id} with the public command ${extension.command}`);
  Object.assign(extension, { path: latest.path, version: latest.version });
}
await access(join(root, 'dist', 'tests', 'host', 'coexistence.js'));
const runRoot = await mkdtemp(join(tmpdir(), 'tickbird-coexistence-'));
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
// VS Code's command: TICKBIRD_CODE_CLI, the Mac app's own, or `code` on the PATH.
const macCode = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const code = process.env.TICKBIRD_CODE_CLI || (existsSync(macCode) ? macCode : 'code');
const args = ['--new-window', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${root}`, ...agentExtensions.map(extension => `--extensionDevelopmentPath=${extension.path}`),
  `--extensionTestsPath=${join(root, 'dist/tests/host/coexistence.js')}`, root];
const childEnvironment = { ...process.env, TICKBIRD_COEXISTENCE_RESULT: resultFile, TICKBIRD_COEXISTENCE_PROJECT: root };
// Production source discovery only. Do not copy profile state, secrets or Agent credential files.
delete childEnvironment.TICKBIRD_TEST_CODEX_ROOT;
delete childEnvironment.TICKBIRD_TEST_CLAUDE_ROOT;
delete childEnvironment.TICKBIRD_TEST_RESULT;
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

// The run's VS Code profile is about 50 MB; the result above is what is kept. TICKBIRD_KEEP_RUN=1 keeps the run too.
// VS Code's helpers go on writing to the profile for a moment after the window closes: wait for them first.
if (!process.env.TICKBIRD_KEEP_RUN) {
  for (let waited = 0; waited < 15_000 && spawnSync('pgrep', ['-f', userData]).status === 0; waited += 250) await new Promise(done => setTimeout(done, 250));
  await rm(runRoot, { recursive: true, force: true });
}
