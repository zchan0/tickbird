import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const version = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')).version;

test('the products and their plugins carry one version', () => {
  const product = version('package.json');
  // Change it with `npm run set-version -- x.y.z`, never by hand in one file.
  assert.equal(version('plugins/sidecar-state/.claude-plugin/plugin.json'), product);
  assert.equal(version('plugins/sidecar-state/.codex-plugin/plugin.json'), product);
  assert.equal(version('package-lock.json'), product);
});
