import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseCodex } from '../packages/core/src/codex';
import { parseClaude } from '../packages/core/src/claude';
import type { Provider } from '../packages/core/src/model';

const projectPath = '/Users/me/Developer/agent-sidecar';
const samples: Array<{ name: string; provider: Provider; file: string; lines: number; sha256: string }> = [
  { name: 'CX1', provider: 'codex', file: '/Users/me/.codex/sessions/2026/08/29/rollout-2026-08-29T13-17-57-01a00000-0000-7000-8000-0000000000c1.jsonl', lines: 1216, sha256: 'f024098aa183b509ba59d536ac8c23bcc42d4fae923afc87a808c5389df27d61' },
  { name: 'CX2', provider: 'codex', file: '/Users/me/.codex/sessions/2026/09/04/rollout-2026-09-04T18-52-56-01a00000-0000-7000-8000-0000000000c2.jsonl', lines: 1282, sha256: 'e4f778a116351de05848dc07e603d18e816794c85d92de305b44fbd2a6b3b198' },
  { name: 'CL1', provider: 'claude', file: '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a1.jsonl', lines: 1133, sha256: '4b2460fe9ea563f1006ddef1d830929a8942b1869fd7772c9d22310e59e8e2dc' },
  { name: 'CL2', provider: 'claude', file: '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a3.jsonl', lines: 244, sha256: '3a610a4c728c07d49d7272279d44a8c233853e5c1b01d2392105e89e66331925' },
  { name: 'CL2-child', provider: 'claude', file: '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a3/subagents/agent-a0c51d6f6a986ff22.jsonl', lines: 21, sha256: '45ff27a95a7b7fe317dbf03658142ed4692f1c4db7812af0a5093d34a808c7f6' }
];
async function main() {
  const results = [];
  for (const sample of samples) {
    const text = (await readFile(sample.file, 'utf8')).split('\n').slice(0, sample.lines).join('\n') + '\n';
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash !== sample.sha256) throw new Error(`${sample.name}: 固定样本哈希已变化，不沿用历史基线。`);
    const session = (sample.provider === 'codex' ? parseCodex : parseClaude)({ text, file: sample.file, projectPath });
    const covered = new Set(session.coverage.map(entry => entry.source.line));
    const missing = Array.from({ length: sample.lines }, (_, i) => i + 1).filter(line => !covered.has(line));
    const invalidDetails = session.items.filter(item => (!!item.detail !== ['available', 'partial'].includes(item.availability)) || !item.sources.length).map(item => item.id);
    const invalidSources = session.items.flatMap(item => item.sources).filter(ref => ref.file !== sample.file || ref.line < 1 || ref.line > sample.lines);
    const duplicateIds = session.items.length - new Set(session.items.map(item => item.id)).size;
    const counts: Record<string, number> = {};
    for (const entry of session.coverage) counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
    results.push({ name: sample.name, provider: sample.provider, sessionId: session.id, sha256: hash, lines: sample.lines,
      itemCount: session.items.length, dispositions: counts, missing, invalidDetails, invalidSources, duplicateIds,
      warnings: session.warnings, unsupported: session.coverage.filter(entry => entry.disposition === 'unsupported'),
      invariantChecksPassed: missing.length === 0 && invalidDetails.length === 0 && invalidSources.length === 0 && duplicateIds === 0 });
  }
  await mkdir('.test-artifacts', { recursive: true });
  await writeFile('.test-artifacts/sample-audit.json', JSON.stringify({ kind: 'real-log-parser-invariants-not-ui-coverage',
    generatedAt: new Date().toISOString(), limitations: ['No original Agent UI or rendered Sidecar comparison in this script.',
      'Coverage disposition does not imply supported rendering. Child file is audited independently, not proof of parent-child integration.'], results }, null, 2) + '\n');
  console.log(JSON.stringify(results.map(({ name, itemCount, dispositions, missing, invalidDetails, duplicateIds, invariantChecksPassed }) => ({ name, itemCount, dispositions, missing, invalidDetails, duplicateIds, invariantChecksPassed })), null, 2));
  if (results.some(result => !result.invariantChecksPassed)) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
