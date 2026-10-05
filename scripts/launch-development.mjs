import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The folder to open; defaults to this checkout. A worktree has no sessions of its own,
// so `npm run dev -- <project>` opens the project whose sessions to read.
const folder = process.argv[2] ?? root;
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
// Manifests only: no account data is read or copied.
for (const directory of await readdir(installed).catch(() => [])) {
  try {
    const path = join(installed, directory);
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    found.push({ path, id: `${manifest.publisher}.${manifest.name}`, version: manifest.version, dependencies: manifest.extensionDependencies ?? [] });
  } catch { /* Ignore an incomplete installation. */ }
}
const latest = id => found.filter(item => item.id.toLowerCase() === id.toLowerCase())
  .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
// Each agent extension with the extensions it declares it needs (Codex needs openai.codex-audio).
const selected = [];
const add = id => {
  const item = latest(id);
  if (!item || selected.includes(item)) return;
  selected.push(item);
  item.dependencies.forEach(add);
};
['openai.chatgpt', 'Anthropic.claude-code'].forEach(add);
const code = process.env.SIDECAR_CODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const args = ['--new-window', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${root}`, ...selected.map(item => `--extensionDevelopmentPath=${item.path}`), folder];
const child = spawn(code, args, { stdio: 'inherit' });
console.log(JSON.stringify({ kind: 'isolated-development-window', runRoot, pid: child.pid, extensions: selected.map(({ path, id, version }) => ({ path, id, version })), project: folder }, null, 2));
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
process.exitCode = exitCode ?? 1;
