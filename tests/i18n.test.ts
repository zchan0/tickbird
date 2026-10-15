import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chooseLanguage, languageOf, setLanguage } from '../packages/core/src/i18n';
import { parseClaude } from '../packages/core/src/claude';
import { visibleTurnGroups } from '../packages/core/src/outline';
import { turnView } from '../packages/core/src/turn-view';
import { SYMBOLS } from '../packages/terminal/src/caps';
import { frame, initialState, key, update, type Model } from '../packages/terminal/src/app';
import { sessionStatus } from '../packages/terminal/src/views/turn-page';
import { plainText } from '../packages/terminal/src/screen';
import { renderSidecar, renderWorkspaceGap } from '../packages/vscode/src/render';

// The README's made-up session: a failed command, reads, edits, a new file, an answer.
const demo = require(resolve(__dirname, '../../demo/session.mjs')) as { transcript(at: number): unknown[]; PROJECT: string };
const session = parseClaude({ file: '/demo/session.jsonl', projectPath: demo.PROJECT, text: demo.transcript(Infinity).map(record => JSON.stringify(record)).join('\n') + '\n' });
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

function model(): Model {
  const groups = visibleTurnGroups(session);
  const now = Date.parse('2026-10-15T10:02:20');
  return { session, groups, status: sessionStatus(turnView(groups.at(-1)!, true, 'claude'), {}, now, { busy: false }), extras: {},
    caps: { links: false, symbols: Object.fromEntries(Object.keys(SYMBOLS).map(ch => [ch, 1])) }, now, width: 60, height: 80 };
}
/** What the side bar shows: its markup with its text, titles and labels; scripts and styles left out. */
const shown = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '');

test('the language is the reader\'s choice when set, else the locale: Chinese for any zh, English for the rest', () => {
  assert.deepEqual(['zh_CN.UTF-8', 'zh-cn', 'zh-Hant', 'zh', 'en_US.UTF-8', 'ja', '', undefined].map(languageOf), ['zh', 'zh', 'zh', 'zh', 'en', 'en', 'en', 'en']);
  assert.equal(chooseLanguage('zh', 'en_US.UTF-8'), 'zh');
  assert.equal(chooseLanguage('en', 'zh_CN.UTF-8'), 'en');
  assert.equal(chooseLanguage('auto', 'zh_CN.UTF-8'), 'zh');
  assert.equal(chooseLanguage(undefined, undefined), 'en');
});

test('in English, a whole turn in the terminal has no Chinese on it: the page, the contents and the keys', () => {
  setLanguage('en');
  try {
    const m = model();
    let state = update(initialState(), m);
    const page = frame(state, m).map(line => plainText(line));
    assert.match(page[0], /Turn 1 of 1 · started \d\d:\d\d .*\? keys/);
    assert.ok(page.some(line => /3 files {2}\+20 -4/.test(line)), page.join('\n'));
    for (const line of page) assert.ok(!CJK.test(line), line);
    for (const name of ['t', '?']) {
      state = key(update(initialState(), m), { type: 'key', name, ctrl: false, alt: false, shift: false }, m);
      for (const line of frame(state, m).map(line => plainText(line))) assert.ok(!CJK.test(line), `${name}: ${line}`);
    }
  } finally { setLanguage('en'); }
});

test('in English, the side bar has no Chinese on it, and its scripts are given English words', () => {
  setLanguage('en');
  try {
    const html = renderSidecar({ projectName: 'wordcount', session, nonce: 'n', streamId: 's' });
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<b>Turn 1<\/b><span class="tsub"> of /);
    assert.match(html, /3 files <span class="csize">/);
    assert.match(html, /const TEXT = \{"kept":"Kept","follow":"↓ Follow"/);
    const text = shown(html);
    assert.ok(!CJK.test(text), text.match(new RegExp(`.{0,40}${CJK.source}.{0,40}`))?.[0]);
    assert.ok(!CJK.test(shown(renderWorkspaceGap('empty', 'n'))));
    // In Chinese, the same page reads in Chinese.
    setLanguage('zh');
    assert.match(renderSidecar({ projectName: 'wordcount', session, nonce: 'n' }), /<b>第 1 轮<\/b>[\s\S]*3 个文件/);
  } finally { setLanguage('en'); }
});
