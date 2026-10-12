// Private install of Tickbird for the terminal, from this checkout. Run it again to update.
//   1. Bundle the command line into one file under ~/.local/share/tickbird/.
//   2. Put the `tickbird` command in ~/.local/bin.
//   3. Bring an older VS Code version up to date: both read the same integration.
//   4. Run `tickbird setup`: the plugins in Claude Code and Codex, and kitty.
// Runs after `npm run build` (see package.json). Nothing is published anywhere.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { OLD, installPaths, olderThan, spawnRunner, vscodeExtension } = require(join(root, 'dist/packages/terminal/src/setup.js'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const paths = installPaths();

// 1. One file, so the install needs no node_modules.
mkdirSync(paths.data, { recursive: true });
const cli = join(paths.data, 'cli.cjs');
await build({ entryPoints: [join(root, 'packages/terminal/src/cli.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outfile: cli, minify: true, legalComments: 'none', logLevel: 'error' });
writeFileSync(join(paths.data, 'install.json'), JSON.stringify({ source: root, version }, null, 2) + '\n');
console.log(`✓ 终端版 ${version}：${cli}`);

// 2. The command: node from PATH, or the node that installed it.
mkdirSync(paths.bin, { recursive: true });
const launcher = join(paths.bin, 'tickbird');
writeFileSync(launcher, `#!/bin/sh
# Tickbird for the terminal (npm run install:terminal). Remove it with: tickbird uninstall
if command -v node >/dev/null 2>&1; then exec node "${cli}" "$@"; fi
exec "${process.execPath}" "${cli}" "$@"
`);
chmodSync(launcher, 0o755);
console.log(`✓ 命令：${launcher}`);
if (!(process.env.PATH ?? '').split(':').includes(paths.bin)) console.log(`· ${paths.bin} 不在 PATH 里：把它加进 shell 配置，才能直接运行 tickbird`);
// The command and program under the earlier name. Only ours: another tool may own a command of that name.
const oldLauncher = join(paths.bin, OLD.command), oldData = join(dirname(paths.data), OLD.command);
if (existsSync(oldLauncher) && readFileSync(oldLauncher, 'utf8').includes('npm run install:terminal')) { rmSync(oldLauncher); console.log(`✓ 移除旧命令：${oldLauncher}`); }
if (existsSync(join(oldData, 'install.json'))) { rmSync(oldData, { recursive: true, force: true }); console.log(`✓ 移除旧程序文件：${oldData}`); }

// 3. An older VS Code version would miss what the new integration no longer records.
const extension = vscodeExtension(spawnRunner);
if (extension && olderThan(extension, version)) {
  console.log(`· VS Code 版是 ${extension}，一起更新到 ${version}：`);
  spawnSync(process.execPath, [join(root, 'scripts/install-vscode.mjs'), '--extension-only'], { stdio: 'inherit' });
}

// 4. The agents' side, asked in this terminal.
const done = spawnSync(process.execPath, [cli, 'setup', '--source', root], { stdio: 'inherit' });
process.exit(done.status ?? 1);
