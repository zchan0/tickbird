// Read only fixed local transcript prefixes. Never replay tool calls or copy bodies.
// First run writes a metadata-only baseline; subsequent runs verify it without overwriting.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { localSamples } from './local-samples.mjs';

// The real sessions this check reads: local/samples.json, kept out of the repository.
const local = localSamples();

const samples = [
  { id: 'CX-A', file: local.files['CX2'], limit: 7893, picks: [1, 7891, 7893], pairs: [[7891, 7893]] },
  { id: 'CL-A', file: local.files['CL-A'], limit: 246, picks: [3, 11, 141, 142, 160, 166, 167, 168, 170, 171, 172], pairs: [[141, 142], [167, 168], [171, 172]] },
  { id: 'CL-B', file: local.files['CL2'], limit: 244, picks: [5, 37, 38, 59, 60, 72, 73, 167, 168, 173, 175, 180, 181], pairs: [[37, 38], [59, 60], [72, 73], [167, 168], [173, 175], [180, 181]] },
];
const sha = source => createHash('sha256').update(source).digest('hex');
function shape(record) {
  const p = record.payload ?? record;
  const content = record.message?.content;
  return { type: record.type, payloadType: p.type, uuid: record.uuid, timestamp: record.timestamp,
    name: p.name, callId: p.call_id, role: record.message?.role ?? p.role,
    blocks: Array.isArray(content) ? content.map(b => ({ type: b.type, name: b.name, id: b.id ?? b.tool_use_id,
      inputKeys: b.input ? Object.keys(b.input) : undefined, isError: b.is_error,
      textLength: typeof b.text === 'string' ? b.text.length : undefined,
      thinkingLength: typeof b.thinking === 'string' ? b.thinking.length : undefined,
      contentType: b.content === undefined ? undefined : Array.isArray(b.content) ? 'array' : typeof b.content })) : undefined };
}
const results = [];
for (const sample of samples) {
  const stream = createReadStream(sample.file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const hash = createHash('sha256'), records = new Map(), counts = {};
  let line = 0;
  try {
    for await (const raw of lines) {
      line++; hash.update(raw + '\n');
      const record = JSON.parse(raw);
      counts[record.type] = (counts[record.type] ?? 0) + 1;
      if (sample.picks.includes(line)) records.set(line, { record, sha256: sha(raw) });
      if (line === sample.limit) break;
    }
  } finally { lines.close(); stream.destroy(); }
  assert.equal(line, sample.limit, `${sample.id}: incomplete fixed prefix`);
  const paired = sample.pairs.map(([input, output]) => {
    const a = records.get(input).record, b = records.get(output).record;
    const call = a.payload?.call_id ?? a.message?.content?.find(x => x.type === 'tool_use')?.id;
    const result = b.payload?.call_id ?? b.message?.content?.find(x => x.type === 'tool_result')?.tool_use_id;
    assert.ok(call && call === result, `${sample.id}:${input}/${output}: identity mismatch`);
    return { input, output, callId: call };
  });
  results.push({ id: sample.id, file: sample.file, prefixLines: line, lfNormalizedPrefixSha256: hash.digest('hex'), counts,
    records: [...records].map(([line, value]) => ({ line, sha256: value.sha256, ...shape(value.record) })), pairs: paired });
}
const baseline = JSON.parse(JSON.stringify({ kind: 'source-shape-and-call-identity-not-visual-acceptance', results }));
const output = new URL('../.test-artifacts/plugin-rendering-reference.json', import.meta.url);
let existing;
try { existing = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) assert.deepEqual(baseline, existing, 'Fixed sources changed; do not silently refresh the evidence baseline');
else { await mkdir(new URL('../.test-artifacts/', import.meta.url), { recursive: true }); await writeFile(output, JSON.stringify(baseline, null, 2) + '\n'); }
console.log(JSON.stringify({ mode: existing ? 'verified' : 'created', samples: results.map(r => ({ id: r.id, lines: r.prefixLines, pairedCalls: r.pairs.length })), bodiesCopied: false }));
