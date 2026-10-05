// One version for the product and its integration:
//   npm run set-version -- 0.2.1
// Sets package.json (and its lockfile) and both integration manifests. Claude Code
// and Codex cache an installed plugin by version, so a changed integration needs a new one.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) { console.error('用法：npm run set-version -- <主版本.次版本.修订号>'); process.exit(1); }
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: root, stdio: 'ignore' });
for (const file of ['integration/.claude-plugin/plugin.json', 'integration/.codex-plugin/plugin.json']) {
  const path = join(root, file), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = version;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`版本已设为 ${version}：package.json、integration 的两份插件清单。`);
