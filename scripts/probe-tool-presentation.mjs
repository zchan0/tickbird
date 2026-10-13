// Metadata-only audit of the same fixed source prefixes and installed renderer bundles.
// Run after npm run build. No tool replay, source-body copying, or private runtime dependency.
import { createReadStream } from 'node:fs';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { recordedToolInputs } = require('../dist/packages/core/src/actions.js');
const { toolView } = require('../dist/packages/core/src/tool-view.js');
const baseline = JSON.parse(await readFile(new URL('../.test-artifacts/plugin-rendering-reference.json', import.meta.url), 'utf8'));
const samples = [];
for (const sample of baseline.results) {
  const stream = createReadStream(sample.file), reader = createInterface({ input: stream, crlfDelay: Infinity });
  const hash = createHash('sha256'), mappings = new Map(); let line = 0;
  try {
    for await (const raw of reader) {
      line++; hash.update(raw + '\n');
      const record = JSON.parse(raw), p = record.payload;
      let calls = [];
      if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p?.type)) {
        const name = [p.namespace, p.name].filter(Boolean).join('/');
        calls = recordedToolInputs({ title: name, detail: { blocks: [{ kind: 'code', label: '记录中的调用参数', text: p.arguments ?? p.input }] } });
      } else if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
        calls = record.message.content.filter(block => block.type === 'tool_use').map(block => ({ name: block.name, input: block.input }));
      }
      for (const call of calls) {
        const view = toolView(call.name, call.input), key = JSON.stringify([call.name, view.name]);
        const row = mappings.get(key) ?? { sourceName: call.name, displayName: view.name, count: 0, firstLine: line };
        row.count++; mappings.set(key, row);
      }
      if (line === sample.prefixLines) break;
    }
  } finally { reader.close(); stream.destroy(); }
  assert.equal(line, sample.prefixLines);
  assert.equal(hash.digest('hex'), sample.lfNormalizedPrefixSha256, `${sample.id}: fixed source changed`);
  samples.push({ id: sample.id, prefixLines: line, mappings: [...mappings.values()] });
}
const installed = JSON.parse(await readFile(join(homedir(), '.vscode', 'extensions', 'extensions.json'), 'utf8'));
const targets = [
  ['anthropic.claude-code', 'webview/index.js', ['name="Bash"', 'name="Skill"', 'var YH1="mcp__"', 'name="Read"', 'name="WebFetch"']],
  ['openai.chatgpt', 'webview/assets/subagent-activity-chip-group-47f38af5edcf.js', ['toolSummaryForCmd.readSkillDefinition.steps.finished', 'skillPathInfo:']],
  ['openai.chatgpt', 'webview/assets/app-initial-960b2458878e.js', ['function jv(', 'case`commandExecution`']],
];
const bundles = [];
for (const [id, relativePath, needles] of targets) {
  const extension = installed.find(extension => extension.identifier.id === id);
  assert.ok(extension, `${id}: not installed`);
  const path = extension.location.path + '/' + relativePath, bytes = await readFile(path), source = bytes.toString('utf8');
  let bundledSourceMap = false;
  try { await access(path + '.map'); bundledSourceMap = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const symbols = needles.map(needle => ({ needle, utf16Offset: source.indexOf(needle) }));
  assert.ok(symbols.every(symbol => symbol.utf16Offset >= 0), `${id}: renderer evidence changed`);
  bundles.push({ id, version: extension.version, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), symbols, bundledSourceMap });
}
const report = { kind: 'recorded-input-classification-not-runtime-or-visual-coverage', samples, bundles, bodiesCopied: false };
await writeFile(new URL('../.test-artifacts/tool-presentation-audit.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ samples: samples.map(sample => ({ id: sample.id, inputs: sample.mappings.reduce((total, row) => total + row.count, 0), toolMappings: sample.mappings.length })), bundles: bundles.length, bodiesCopied: false }));
