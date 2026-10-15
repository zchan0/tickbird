import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const changelog = require(resolve(__dirname, '../../scripts/changelog.mjs')) as {
  section(text: string, title: string): string | undefined;
  release(text: string, version: string, date: string): string;
};

const SAMPLE = '# Changelog\n\nAbout it.\n\n## Unreleased\n\n### Fixed\n\n- A fix.\n\n## 0.8.0 - 2026-10-13\n\n- The release before.\n\nEarlier versions: see GitHub Releases.\n';

test('releasing turns what is under Unreleased into the version\'s section, and leaves Unreleased empty above it', () => {
  const released = changelog.release(SAMPLE, '0.8.1', '2026-10-15');
  assert.equal(changelog.section(released, '0.8.1'), '### Fixed\n\n- A fix.');
  assert.equal(changelog.section(released, 'Unreleased'), '');
  assert.equal(changelog.section(released, '0.8.0'), '- The release before.', 'The closing line is no part of the last release');
  assert.equal(changelog.section(released, '0.8'), undefined, 'A version is matched whole');
  assert.throws(() => changelog.release('# Changelog\n', '0.8.1', '2026-10-15'));
});

test('the changelog in the repository has the section npm run release looks for, and the current version\'s once released', () => {
  const text = readFileSync(resolve(__dirname, '../../CHANGELOG.md'), 'utf8');
  assert.notEqual(changelog.section(text, 'Unreleased'), undefined);
  const version = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version as string;
  assert.ok(changelog.section(text, version), `CHANGELOG.md has ${version}`);
});
