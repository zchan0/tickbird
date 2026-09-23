import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runRoot = await mkdtemp(join(tmpdir(), 'sidecar-development-'));
const userData = join(runRoot, 'user-data');
const extensions = join(runRoot, 'extensions');
await Promise.all([mkdir(join(userData, 'User'), { recursive: true }), mkdir(extensions)]);
await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
  'window.restoreWindows': 'none', 'workbench.startupEditor': 'none',
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.editor.closeEmptyGroups': true
}, null, 2));
// Load existing extension code in an isolated development profile. Do not install, update, or copy credentials.
const installed = join(homedir(), '.vscode', 'extensions');
const found = [];
for (const directory of await readdir(installed).catch(() => [])) {
  if (!/^(openai.chatgpt|anthropic.claude-code)-/.test(directory)) continue;
  try {
    const path = join(installed, directory);
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    found.push({ path, id: `${manifest.publisher}.${manifest.name}`, version: manifest.version });
  } catch { /* Ignore an incomplete installation without reading any account data. */ }
}
const selected = ['openai.chatgpt', 'Anthropic.claude-code'].flatMap(id => {
  const values = found.filter(item => item.id === id).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return values.slice(0, 1);
});
const code = process.env.SIDECAR_CODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const args = ['--new-window', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${root}`, ...selected.map(item => `--extensionDevelopmentPath=${item.path}`), root];
const child = spawn(code, args, { stdio: 'inherit' });
console.log(JSON.stringify({ kind: 'isolated-development-window', runRoot, pid: child.pid, extensions: selected, project: root }, null, 2));
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
process.exitCode = exitCode ?? 1;
