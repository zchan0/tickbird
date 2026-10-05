// Private install of Agent Sidecar for VS Code, from this checkout. Run it again to update.
//   1. Bundle the extension and package build/agent-sidecar-<version>.vsix.
//   2. Install the .vsix into VS Code.
//   3. Install the integration into Claude Code and Codex from this checkout's marketplaces.
// `--package-only` stops after step 1. Nothing is published anywhere.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageOnly = process.argv.includes('--package-only');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'build', 'vsix');
const vsix = join(root, 'build', `${manifest.name}-${manifest.version}.vsix`);
const MARKETPLACE = 'agent-sidecar-local', PLUGIN = 'agent-sidecar', ID = `${PLUGIN}@${MARKETPLACE}`;
let failed = false;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { ok: result.status === 0 && !result.error, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), missing: result.error?.code === 'ENOENT' };
};
const json = (command, args) => { const result = run(command, args); try { return result.ok ? JSON.parse(result.out) : undefined; } catch { return undefined; } };
const report = (ok, what, note = '') => { if (!ok) failed = true; console.log(`${ok ? '✓' : '✗'} ${what}${note ? `：${note}` : ''}`); };
const lastLine = text => text.split('\n').filter(Boolean).at(-1) ?? '';

// 1. One bundled file, so the .vsix carries no node_modules.
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await build({ entryPoints: [join(root, 'packages/vscode/src/extension.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['vscode'], outfile: join(stage, 'extension.js'), minify: true, legalComments: 'none', logLevel: 'error' });
const { scripts: _scripts, dependencies: _dependencies, devDependencies: _devDependencies, private: _private, ...fields } = manifest;
await writeFile(join(stage, 'package.json'), JSON.stringify({ ...fields, main: './extension.js' }, null, 2) + '\n');
await cp(join(root, 'resources'), join(stage, 'resources'), { recursive: true });
await writeFile(join(stage, 'README.md'), `# Agent Sidecar\n\nVS Code 侧边栏里的只读过程观察器：读取当前项目的 Claude Code / Codex 本地会话记录，把 Agent 每一轮做了什么整理成章节。由本地仓库的 \`npm run install:vscode\` 构建安装，未在扩展市场发布。\n`);
const packaged = run(process.execPath, [join(root, 'node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', vsix], { cwd: stage });
report(packaged.ok, '打包 .vsix', packaged.ok ? vsix.replace(root + '/', '') : packaged.out);
if (!packaged.ok || packageOnly) process.exit(packaged.ok ? 0 : 1);

// 2. VS Code.
const code = process.env.SIDECAR_CODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const extension = run(code, ['--install-extension', vsix, '--force']);
report(extension.ok, 'VS Code 扩展', extension.ok ? '已安装；已打开的窗口执行 Developer: Reload Window 后生效' : extension.out);

// 3a. Claude Code: this checkout as a folder marketplace; a changed integration gets a new content version.
const claudeMarkets = json('claude', ['plugin', 'marketplace', 'list', '--json']);
if (!claudeMarkets) report(false, 'Claude Code 接入', '没有找到 claude 命令，跳过');
else {
  const market = claudeMarkets.some(item => item.name === MARKETPLACE)
    ? run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE]) : run('claude', ['plugin', 'marketplace', 'add', root]);
  const installed = (json('claude', ['plugin', 'list', '--json']) ?? []).some(item => item.id === ID);
  const plugin = market.ok && (installed ? run('claude', ['plugin', 'update', ID]) : run('claude', ['plugin', 'install', ID, '--scope', 'user']));
  report(Boolean(market.ok && plugin?.ok), 'Claude Code 接入', !market.ok ? market.out : plugin.ok ? `${installed ? '已更新' : '已安装'}（/plugin 里可以停用）；新开的会话生效` : plugin.out);
}

// 3b. Codex: the same folder through .agents/plugins/marketplace.json.
const codexMarkets = json('codex', ['plugin', 'marketplace', 'list', '--json']);
if (!codexMarkets) report(false, 'Codex 接入', '没有找到 codex 命令，跳过');
else {
  const known = (codexMarkets.marketplaces ?? []).some(item => item.name === MARKETPLACE);
  const market = known ? { ok: true } : run('codex', ['plugin', 'marketplace', 'add', root]);
  const plugin = market.ok && run('codex', ['plugin', 'add', ID]);
  report(Boolean(market.ok && plugin?.ok), 'Codex 接入', !market.ok ? market.out : plugin.ok ? '已安装' : lastLine(plugin.out));
  if (market.ok && plugin?.ok) console.log('  还差一步：在 Codex CLI 里执行 /hooks，按 t 信任 agent-sidecar 的 hook。未信任时 Codex 会静默跳过它们。');
}

process.exit(failed ? 1 : 0);
