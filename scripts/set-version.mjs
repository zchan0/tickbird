// One version for the product and its integration:
//   npm run set-version -- 0.2.1
// Sets package.json (and its lockfile) and every plugin manifest under plugins/, and builds the
// terminal program tickbird-split carries (plugins/tickbird-split/program). Claude Code
// and Codex cache an installed plugin by version, so a changed integration needs a new one.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) { console.error('用法：npm run set-version -- <主版本.次版本.修订号>'); process.exit(1); }
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: root, stdio: 'ignore' });
const manifests = readdirSync(join(root, 'plugins')).flatMap(plugin => ['.claude-plugin', '.codex-plugin'].map(kind => `plugins/${plugin}/${kind}/plugin.json`));
for (const file of manifests) {
  const path = join(root, file), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = version;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
// The terminal program travels inside tickbird-split: built anew with each version, the only time an agent takes a plugin's update.
execFileSync('npm', ['run', 'bundle:plugin'], { cwd: root, stdio: 'ignore' });
console.log(`版本已设为 ${version}：package.json、plugins/ 下的插件清单，并重新打包 plugins/tickbird-split/program/tickbird.cjs。`);
