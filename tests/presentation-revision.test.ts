import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { presentationCases } from './fixtures/presentation-cases';
import { renderDetail, renderInlineEvidence, renderSidecar, projectSidecar, type TurnRenderCache } from '../packages/vscode/src/render';
import { execCommandHint, recordedToolInputs } from '../packages/core/src/actions';
import { parseCodex } from '../packages/core/src/codex';
import { parseClaude } from '../packages/core/src/claude';
import { hasReadableEvidence, resolveOutlineEvidence } from '../packages/core/src/outline';
const sample = (id: string) => structuredClone(presentationCases.find(value => value.id === id)!.session);
const doc = (id: string, locale?: string) => new JSDOM(renderSidecar({ projectName: 'fixture', session: sample(id), nonce: 'fixture', locale })).window.document;

test('Bash occurrences remain sequential rows; each opens exactly its own call and output', () => {
  const data = sample('bash-sequence');
  data.items.push({ ...structuredClone(data.items[1]), id: 'again' });
  const document = new JSDOM(renderSidecar({ projectName: 'fixture', session: data, nonce: 'fixture' })).window.document;
  const steps = [...document.querySelectorAll<HTMLElement>('.crow[data-tool="Bash"]')];
  assert.equal(steps.length, 3, 'Repeated identical calls are not merged');
  assert.equal(new Set(steps.map(step => step.dataset.itemId)).size, 3);
  for (const step of steps) {
    const evidence = resolveOutlineEvidence(data, step.dataset.itemId!)!;
    assert.equal(evidence.items?.length ?? 1, 1, 'A row opens one call, not its neighbours');
    const inline = new JSDOM(renderInlineEvidence(evidence)).window.document;
    assert.ok(inline.querySelector('[data-io="output"]'), 'Its own output travels with it');
    assert.equal(inline.querySelector('button[data-item-id]'), null);
  }
});

test('nested identical Bash occurrences are not deduplicated and shared output appears once as its own row', () => {
  const data = sample('wrapper');
  data.items[1].detail!.blocks[0].text = 'await tools.exec_command({cmd:"a"}); await tools.exec_command({cmd:"b"}); await tools.exec_command({cmd:"a"});';
  const document = new JSDOM(renderSidecar({ projectName: 'fixture', session: data, nonce: 'fixture' })).window.document;
  const steps = [...document.querySelectorAll<HTMLElement>('.crow-item:has(.crow[data-tool="Bash"])')];
  assert.equal(steps.length, 3);
  assert.equal(new Set(steps.map(node => node.dataset.observationKey)).size, 3);
  const outputs = document.querySelectorAll<HTMLElement>('.crow[data-tool="OUT"]');
  assert.equal(outputs.length, 1, 'One shared wrapper output, never copied onto each call');
  const shared = resolveOutlineEvidence(data, outputs[0].dataset.itemId!)!;
  assert.equal(shared.role, 'output');
});

test('no-output action has no unknown-status boilerplate, no output row and still opens its input', () => {
  const document = doc('no-output');
  assert.equal(document.querySelectorAll('.crow[data-tool="OUT"]').length, 0);
  assert.ok(document.querySelector('.crow[data-tool="Bash"][data-item-id]'));
  assert.ok(!document.body.textContent!.includes('状态未核实'));
  assert.equal(sample('no-output').items[1].status, 'unknown');
});

test('compaction is localized only in UI; no summary means no arrow or detail entry', () => {
  for (const [locale, expected] of [['zh-cn', '上下文已压缩'], ['en', 'Context compacted']]) {
    const document = doc('compaction', locale);
    assert.equal(document.querySelector('.compact-marker')!.textContent, expected);
    assert.equal(document.querySelector('.compact-marker[data-item-id], .compact-marker .node-arrow'), null);
    assert.equal(hasReadableEvidence(sample('compaction').items[1]), false);
    const summary = sample('compaction-summary').items[1];
    assert.equal(doc('compaction-summary', locale).querySelectorAll('details.compact-marker').length, 1);
    const detail = new JSDOM(renderDetail({ item: summary, provider: 'codex', kept: false, nonce: 'fixture', locale })).window.document;
    assert.equal(detail.querySelector('.detail-heading h1')!.textContent, locale === 'en' ? 'Compaction summary' : '压缩摘要');
    assert.equal(detail.querySelector('.markdown h2')!.textContent, '已完成', 'Source summary is not translated');
  }
  const cache: TurnRenderCache = new Map();
  const data = sample('compaction');
  assert.ok(projectSidecar({ projectName: 'f', session: data, locale: 'zh-cn' }, cache).turns[0].html.includes('上下文已压缩'));
  assert.ok(projectSidecar({ projectName: 'f', session: data, locale: 'en' }, cache).turns[0].html.includes('Context compacted'));
});

test('Codex compaction reads only explicit nonempty message, keeps source and never dumps encrypted or replacement history', () => {
  const parse = (...records: unknown[]) => parseCodex({ projectPath: '/fixture', file: '/synthetic/compaction.jsonl', text: records.map(record => JSON.stringify(record)).join('\n') });
  const boundary = { type: 'event_msg', payload: { type: 'context_compacted', turn_id: 'turn' } };
  const compacted = { type: 'compacted', payload: { turn_id: 'turn', message: '**Saved summary**', replacement_history: [{ role: 'developer', content: 'PRIVATE_REPLACEMENT' }], guardian_history: 'PRIVATE_GUARDIAN' } };
  const data = parse(boundary, compacted);
  assert.equal(data.items.length, 1); assert.equal(data.items[0].sources.length, 2);
  assert.equal(data.items[0].noticeType, 'context-compacted');
  assert.ok(hasReadableEvidence(data.items[0]));
  assert.equal(data.items[0].detail!.blocks[0].text, '**Saved summary**');
  assert.ok(!JSON.stringify(data.items).includes('PRIVATE_'));
  const missing = parse({ ...compacted, payload: { ...compacted.payload, message: '' } });
  assert.equal(hasReadableEvidence(missing.items[0]), false);
  const claude = parseClaude({ projectPath: '/fixture', file: '/synthetic/claude.jsonl', text: JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'PRIVATE_SYSTEM', sessionId: 'c' }) });
  assert.equal(claude.items[0].noticeType, 'context-compacted');
  assert.equal(hasReadableEvidence(claude.items[0]), false);
});

test('exec command hint is syntax only, never evaluates expressions, branches, comments or shadowed tools', () => {
  const source = 'if (needsCheck) await tools.exec_command({cmd: command});';
  assert.equal(execCommandHint(source), '[cmd: command]');
  assert.equal(execCommandHint('await tools.exec_command({cmd: "npm test", workdir: folder});'), '[npm test]');
  for (const value of ['// tools.exec_command({cmd: "no"})', 'const tools = fake; tools.exec_command({cmd: "no"})', 'function later() { tools.exec_command({cmd: "no"}); }', 'await tools.exec_command({cmd: "a", ...unknown});', 'if (']) assert.equal(execCommandHint(value), undefined);
  const item = sample('opaque').items[1];
  assert.deepEqual(recordedToolInputs(item), [{ name: 'exec', input: source }]);
  const document = doc('opaque');
  assert.equal(document.querySelector('.crow .ctool')!.textContent, 'Script');
  assert.equal(document.querySelector('.crow .clabel')!.textContent, '调用 Bash · 动态参数');
});

test('Write shows short filenames and only a file opens a separate recorded diff', () => {
  const data = sample('file-event'), document = doc('file-event');
  const file = document.querySelector<HTMLButtonElement>('.crow[data-tool="Write"]')!;
  assert.equal(file.querySelector('.ctool')!.textContent, 'Write');
  assert.equal(file.querySelector('.clabel')!.textContent, 'model.ts');
  const evidence = resolveOutlineEvidence(data, file.dataset.itemId!)!;
  assert.equal(evidence.item.detail!.blocks[0].label, 'packages/core/src/model.ts');
  assert.match(evidence.item.detail!.provenance!, /历史修改记录/);
});
