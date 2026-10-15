// CHANGELOG.md, as Keep a Changelog keeps it: what is not released yet under
// "## Unreleased", each release under "## <version> - <date>".
//   node scripts/changelog.mjs notes 0.8.1   prints that version's section (the Release workflow's notes)
// npm run release reads the unreleased section and, releasing, turns it into the version's.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const changelogPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'CHANGELOG.md');
export const UNRELEASED = '## Unreleased';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body under a `## ` heading whose text starts with `title`, up to the next `## ` heading or the closing line. */
export function section(text, title) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => new RegExp(`^## ${escape(title)}(?:\\s|$)`).test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && (/^## /.test(line) || /^Earlier versions/.test(line)));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** The unreleased section turned into `version`'s, dated `date`, with an empty unreleased section above it. */
export function release(text, version, date) {
  if (!text.includes(`\n${UNRELEASED}\n`)) throw new Error(`CHANGELOG.md 里没有「${UNRELEASED}」这一节`);
  return text.replace(`\n${UNRELEASED}\n`, `\n${UNRELEASED}\n\n## ${version} - ${date}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'notes') {
  const notes = section(readFileSync(changelogPath, 'utf8'), process.argv[3] ?? '');
  if (!notes) { console.error(`CHANGELOG.md 里没有 ${process.argv[3]} 这一节`); process.exit(1); }
  console.log(notes);
}

export const readChangelog = () => readFileSync(changelogPath, 'utf8');
export const writeChangelog = text => writeFileSync(changelogPath, text);
