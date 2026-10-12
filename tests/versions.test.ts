import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const version = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')).version;

test('the products and their plugins carry one version', () => {
  const product = version('package.json');
  // Change it with `npm run set-version -- x.y.z`, never by hand in one file.
  for (const plugin of ['tickbird-state', 'tickbird-split']) {
    assert.equal(version(`plugins/${plugin}/.claude-plugin/plugin.json`), product, plugin);
    assert.equal(version(`plugins/${plugin}/.codex-plugin/plugin.json`), product, plugin);
  }
  assert.deepEqual(readdirSync(join(root, 'plugins')).sort(), ['tickbird-split', 'tickbird-state'], 'A new plugin is checked here too');
  assert.equal(version('package-lock.json'), product);
});
