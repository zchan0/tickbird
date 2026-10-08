// Private install of Agent Sidecar for VS Code, from this checkout. Run it again to update.
//   1. Bundle the extension and package build/agent-sidecar-<version>.vsix.
//   2. Install the .vsix into VS Code.
//   3. Install the integration into Claude Code and Codex from this checkout's marketplaces.
// `--package-only` stops after step 1, `--extension-only` after step 2 (the terminal
// install runs it, then installs the plugins itself). Runs after `npm run build`.
// Nothing is published anywhere.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageOnly = process.argv.includes('--package-only'), extensionOnly = process.argv.includes('--extension-only');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = join(root, 'build', 'vsix');
const vsix = join(root, 'build', `${manifest.name}-${manifest.version}.vsix`);
// The extension's name before 2026-10-05; removed on sight so a reinstall leaves one copy.
const OLD = { extension: 'agent-sidecar-local.agent-sidecar' };
let failed = false;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { ok: result.status === 0 && !result.error, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), missing: result.error?.code === 'ENOENT' };
};
const report = (ok, what, note = '') => { if (!ok) failed = true; console.log(`${ok ? '✓' : '✗'} ${what}${note ? `：${note}` : ''}`); };

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
if (run(code, ['--list-extensions']).out.split('\n').includes(OLD.extension)) report(run(code, ['--uninstall-extension', OLD.extension]).ok, `移除旧扩展 ${OLD.extension}`);
const extension = run(code, ['--install-extension', vsix, '--force']);
report(extension.ok, 'VS Code 扩展', extension.ok ? '已安装；已打开的窗口执行 Developer: Reload Window 后生效' : extension.out);

// 3. The integration in Claude Code and Codex, the same code `agent-sidecar setup` runs.
if (!extensionOnly) {
  const { claudePlugins, codexPlugins, consoleReport, spawnRunner, STATE } = createRequire(import.meta.url)(join(root, 'dist/packages/terminal/src/setup.js'));
  const plugins = consoleReport();
  claudePlugins(spawnRunner, root, [STATE], plugins);
  if (codexPlugins(spawnRunner, root, [STATE], plugins)) console.log('  还差一步：Codex 第一次启动时会提示 Hooks need review，选 Trust all（或在 Codex 里执行 /hooks，按 t）。未信任时 Codex 会静默跳过它们。');
  if (plugins.failed) failed = true;
}

process.exit(failed ? 1 : 0);
