import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const changelog = require(resolve(__dirname, '../../scripts/changelog.mjs')) as {
  section(text: string, title: string): string | undefined;
  release(text: string, version: string, date: string): string;
};

const SAMPLE = '# 更新记录\n\n说明。\n\n## 未发布\n\n### 修复\n\n- 一处修复。\n\n## 0.8.0 · 2026-10-13\n\n- 上一版。\n\n更早的版本见 GitHub Releases。\n';

test('releasing turns what is under 未发布 into the version\'s section, and leaves 未发布 empty above it', () => {
  const released = changelog.release(SAMPLE, '0.8.1', '2026-10-15');
  assert.equal(changelog.section(released, '0.8.1'), '### 修复\n\n- 一处修复。');
  assert.equal(changelog.section(released, '未发布'), '');
  assert.equal(changelog.section(released, '0.8.0'), '- 上一版。', 'The closing line is no part of the last release');
  assert.equal(changelog.section(released, '0.8'), undefined, 'A version is matched whole');
  assert.throws(() => changelog.release('# 更新记录\n', '0.8.1', '2026-10-15'));
});

test('the changelog in the repository has the section npm run release looks for, and the current version\'s once released', () => {
  const text = readFileSync(resolve(__dirname, '../../CHANGELOG.md'), 'utf8');
  assert.notEqual(changelog.section(text, '未发布'), undefined);
  const version = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version as string;
  assert.ok(changelog.section(text, version), `CHANGELOG.md has ${version}`);
});
