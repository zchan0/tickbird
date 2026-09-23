import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseCodex } from '../packages/core/src/codex';
import { parseClaude } from '../packages/core/src/claude';
import type { ItemKind, Provider, SessionData, TimelineItem } from '../packages/core/src/model';

// Independent fixed-source checks. No parser helpers, current files, referenced
// URLs, child output paths, or private instruction/reasoning bodies are read.
const projectPath = '/Users/me/Developer/agent-sidecar';
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const required = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
const string = (value: unknown): string => { required(typeof value === 'string', 'Expected source text field is missing.'); return value as string; };
const array = (value: unknown): unknown[] => { required(Array.isArray(value), 'Expected source content array is missing.'); return value as unknown[]; };
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => (value as Obj)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((value as Obj)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

interface Sample { name: string; provider: Provider; file: string; lines: number; hash: string }
const samples: Sample[] = [
  { name: 'CX1', provider: 'codex', file: '/Users/me/.codex/sessions/2026/08/29/rollout-2026-08-29T13-17-57-01a00000-0000-7000-8000-0000000000c1.jsonl', lines: 1216, hash: 'f024098aa183b509ba59d536ac8c23bcc42d4fae923afc87a808c5389df27d61' },
  { name: 'CX2', provider: 'codex', file: '/Users/me/.codex/sessions/2026/09/04/rollout-2026-09-04T18-52-56-01a00000-0000-7000-8000-0000000000c2.jsonl', lines: 1282, hash: 'e4f778a116351de05848dc07e603d18e816794c85d92de305b44fbd2a6b3b198' },
  { name: 'CL1', provider: 'claude', file: '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a1.jsonl', lines: 1133, hash: '4b2460fe9ea563f1006ddef1d830929a8942b1869fd7772c9d22310e59e8e2dc' },
  { name: 'CL2', provider: 'claude', file: '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a3.jsonl', lines: 244, hash: '3a610a4c728c07d49d7272279d44a8c233853e5c1b01d2392105e89e66331925' },
  { name: 'CL2-child', provider: 'claude', file: '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a3/subagents/agent-a0c51d6f6a986ff22.jsonl', lines: 21, hash: '45ff27a95a7b7fe317dbf03658142ed4692f1c4db7812af0a5093d34a808c7f6' },
];
interface Loaded { sample: Sample; rows: Obj[]; normalized: SessionData }
interface Origin { line: number; block?: number; nestedBlock?: number; field: string; callId?: string; relatedLines?: number[] }
interface Check { id: string; sample: string; provider: Provider; category: string; source: Origin & { file: string }; comparison: string; passed: boolean; metadata: Obj }
const checks: Check[] = [];
const loaded = new Map<string, Loaded>();
const row = (data: Loaded, line: number): Obj => { required(line >= 1 && line <= data.sample.lines, 'Source line is outside fixed sample.'); return data.rows[line - 1]; };
const payload = (data: Loaded, line: number): Obj => object(row(data, line).payload);
const block = (data: Loaded, line: number, index = 1): Obj => object(array(object(row(data, line).message).content)[index - 1]);
const itemAt = (data: Loaded, source: Origin, kind?: ItemKind): TimelineItem => {
  const found = data.normalized.items.filter(item => (!kind || item.kind === kind) && item.sources.some(ref => ref.file === data.sample.file && ref.line === source.line && (source.block === undefined || ref.block === undefined || ref.block === source.block)));
  required(found.length === 1, `Expected exactly one source-associated normalized item; found ${found.length}.`);
  return found[0];
};
const texts = (item: TimelineItem): string[] => [item.summary, ...(item.detail?.blocks.filter(b => typeof b.text === 'string').map(b => b.text!) ?? [])];
const run = (sampleName: string, id: string, category: string, source: Origin, compare: (data: Loaded) => { comparison: string; passed: boolean; metadata: Obj }): void => {
  const data = loaded.get(sampleName)!;
  try { checks.push({ id, sample: sampleName, provider: data.sample.provider, category, source: { file: data.sample.file, ...source }, ...compare(data) }); }
  catch (error) {
    // Only our own structural errors are allowed into the metadata report. No
    // assertion library is used that might print raw expected/actual bodies.
    checks.push({ id, sample: sampleName, provider: data.sample.provider, category, source: { file: data.sample.file, ...source }, comparison: 'source-shape-and-associated-item', passed: false, metadata: { error: error instanceof Error ? error.message : 'Unexpected check error.' } });
  }
};
const exactText = (data: Loaded, source: Origin, expected: string, kind?: ItemKind, requiredLabel?: string) => {
  const item = itemAt(data, source, kind);
  const candidates = requiredLabel ? item.detail?.blocks.filter(b => b.label === requiredLabel && typeof b.text === 'string').map(b => b.text!) ?? [] : texts(item);
  const matches = candidates.filter(text => text === expected);
  return { comparison: 'exact-UTF8-text', passed: matches.length > 0, metadata: { itemId: item.id, itemKind: item.kind, availability: item.availability, expectedSha256: sha256(expected), expectedUtf8Bytes: Buffer.byteLength(expected), matchingRepresentations: matches.length, candidateSha256: candidates.map(sha256) } };
};
const exactStructure = (data: Loaded, source: Origin, expected: unknown, label: string) => {
  const item = itemAt(data, source); const expectedCanonical = canonical(expected);
  const candidates: string[] = [];
  for (const candidate of item.detail?.blocks.filter(b => b.kind === 'json' && b.label === label) ?? []) {
    if (candidate.text) { try { candidates.push(canonical(JSON.parse(candidate.text))); } catch { /* recorded as no matching structure */ } }
  }
  return { comparison: 'exact-canonical-JSON-structure', passed: candidates.some(c => c === expectedCanonical), metadata: { itemId: item.id, expectedSha256: sha256(expectedCanonical), expectedUtf8Bytes: Buffer.byteLength(expectedCanonical), candidateSha256: candidates.map(sha256) } };
};
const actualMime = (bytes: Buffer): string | undefined => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : undefined;
const exactImage = (data: Loaded, source: Origin, encoded: string, declaredMime: string) => {
  const bytes = Buffer.from(encoded, 'base64'); const digest = sha256(bytes); const sniffed = actualMime(bytes);
  required(sniffed, 'Selected image does not have the expected PNG/JPEG signature.');
  const item = itemAt(data, source);
  const matching = item.detail?.blocks.filter(b => b.kind === 'image' && b.data && sha256(Buffer.from(b.data, 'base64')) === digest) ?? [];
  // A mirrored source declaring two MIME types must not create two images or
  // override the format established by the actual bytes.
  return { comparison: 'decoded-image-byte-hash-and-format', passed: matching.length === 1 && matching[0].mime === sniffed, metadata: { itemId: item.id, expectedSha256: digest, decodedBytes: bytes.length, sourceDeclaredMime: declaredMime, sourceSignatureMime: sniffed, sourceMimeDisagreesWithSignature: declaredMime !== sniffed, normalizedMatchingImages: matching.length, normalizedMimes: matching.map(b => b.mime), normalizedByteSha256: matching.map(b => sha256(Buffer.from(b.data!, 'base64'))) } };
};

const allEmbeddedImages = (data: Loaded, expectedCount: number) => {
  const images: Array<{ source: Origin; bytes: Buffer; declaredMime: string }> = [];
  let pathOnlyRecordsExcluded = 0;
  let referenceOnlyBlocksExcluded = 0;
  for (const [index, record] of data.rows.entries()) {
    const line = index + 1;
    if (data.sample.provider === 'codex') {
      const p = object(record.payload);
      if (record.type === 'event_msg' && p.type === 'item_completed' && object(p.item).type === 'ImageView') pathOnlyRecordsExcluded++;
      // Count the response-side result once. MCP-end image mirrors are not a
      // second source occurrence and cannot double the expected multiplicity.
      if (record.type !== 'response_item' || !['custom_tool_call_output', 'function_call_output'].includes(String(p.type)) || !Array.isArray(p.output)) continue;
      for (const [blockIndex, value] of p.output.entries()) {
        const b = object(value); if (b.type !== 'input_image') continue;
        const uri = string(b.image_url); const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(uri);
        if (!match) { referenceOnlyBlocksExcluded++; continue; }
        images.push({ source: { line, block: blockIndex + 1, field: `payload.output[${blockIndex}].image_url`, callId: string(p.call_id) }, bytes: Buffer.from(match[2], 'base64'), declaredMime: match[1] });
      }
    } else {
      if (record.type !== 'user' || !Array.isArray(object(record.message).content)) continue;
      for (const [blockIndex, value] of array(object(record.message).content).entries()) {
        const result = object(value); if (result.type !== 'tool_result' || !Array.isArray(result.content)) continue;
        for (const [nestedIndex, content] of result.content.entries()) {
          const b = object(content); if (b.type !== 'image') continue;
          const image = object(b.source);
          if (image.type !== 'base64') { referenceOnlyBlocksExcluded++; continue; }
          images.push({ source: { line, block: blockIndex + 1, nestedBlock: nestedIndex + 1, field: `message.content[${blockIndex}].content[${nestedIndex}].source`, callId: string(result.tool_use_id) }, bytes: Buffer.from(string(image.data), 'base64'), declaredMime: string(image.media_type) });
        }
      }
    }
  }
  const records = images.map(image => {
    const item = itemAt(data, image.source);
    const matching = item.detail?.blocks.filter(b => b.kind === 'image' && b.data && Buffer.from(b.data, 'base64').equals(image.bytes)) ?? [];
    const format = actualMime(image.bytes);
    return { source: image.source, itemId: item.id, expectedSha256: sha256(image.bytes), decodedBytes: image.bytes.length, sourceDeclaredMime: image.declaredMime, sourceSignatureMime: format, byteExactMatch: matching.length > 0, formatMatched: !!format && matching.every(b => b.mime === format), normalizedMatchCount: matching.length, normalizedSha256: matching.map(b => sha256(Buffer.from(b.data!, 'base64'))) };
  });
  const expectedMultiplicity = new Map<string, number>();
  for (const record of records) { const key = `${record.itemId}:${record.expectedSha256}`; expectedMultiplicity.set(key, (expectedMultiplicity.get(key) ?? 0) + 1); }
  const countMismatches = records.filter(record => record.normalizedMatchCount !== expectedMultiplicity.get(`${record.itemId}:${record.expectedSha256}`));
  const failed = records.filter(record => !record.byteExactMatch || !record.formatMatched);
  return { comparison: 'all-fixed-response-inline-image-blocks-byte-for-byte-and-multiplicity', passed: images.length === expectedCount && failed.length === 0 && countMismatches.length === 0,
    metadata: { expectedContentBlockCount: expectedCount, contentBlockCount: images.length, sourceRecordCount: new Set(images.map(image => image.source.line)).size, normalizedItemCount: new Set(records.map(record => record.itemId)).size, byteExactMatchedCount: records.filter(record => record.byteExactMatch).length, formatMatchedCount: records.filter(record => record.formatMatched).length, multiplicityMismatchCount: countMismatches.length, pathOnlyRecordsExcluded, referenceOnlyBlocksExcluded,
      countingRule: 'Each embedded image occurrence in response-side tool output counts once; MCP/event mirrors do not count again. Equal bytes intentionally repeated in authoritative outputs retain their per-item multiplicity. Paths and remote references are excluded, never reported as byte matches.', records } };
};

const allPublicCodexSubagentReturns = (data: Loaded) => {
  let sourceMessageCount = 0; let headerOnlyBlocksExcluded = 0; let opaqueBlocksExcluded = 0;
  const records: Obj[] = [];
  for (const [index, record] of data.rows.entries()) {
    const p = object(record.payload);
    if (record.type !== 'response_item' || p.type !== 'agent_message') continue;
    sourceMessageCount++;
    for (const [blockIndex, value] of array(p.content).entries()) {
      const content = object(value);
      if (content.type === 'encrypted_content') { opaqueBlocksExcluded++; continue; }
      if (content.type !== 'input_text') continue;
      const text = string(content.text);
      // Independently distinguish the transport-only header from a body using
      // the payload delimiter. Opaque block fields are never read or hashed.
      const delimiter = text.indexOf('\nPayload:\n');
      if (text.startsWith('Message Type:') && delimiter >= 0 && !text.slice(delimiter + '\nPayload:\n'.length).trim()) { headerOnlyBlocksExcluded++; continue; }
      const source = { line: index + 1, block: blockIndex + 1, field: `payload.content[${blockIndex}].text` };
      const item = itemAt(data, source, 'subagent');
      const exact = item.detail?.blocks.filter(b => b.kind === 'text' && b.text === text) ?? [];
      records.push({ source, itemId: item.id, expectedSha256: sha256(text), expectedUtf8Bytes: Buffer.byteLength(text), matchingRepresentations: exact.length, normalizedSha256: exact.map(b => sha256(b.text!)), byteExactMatch: exact.some(b => Buffer.from(b.text!, 'utf8').equals(Buffer.from(text, 'utf8'))), parentOnlyBoundaryPresent: !!item.detail?.notice?.includes('不代表子 Agent 内部过程完整') });
    }
  }
  const matched = records.filter(record => record.byteExactMatch === true && record.parentOnlyBoundaryPresent === true).length;
  return { comparison: 'all-fixed-public-subagent-text-blocks-exact-UTF8', passed: records.length === 22 && matched === 22,
    metadata: { expectedContentBlockCount: 22, contentBlockCount: records.length, sourceRecordCount: new Set(records.map(record => object(record.source).line)).size, sourceMessageCount, byteExactMatchedCount: records.filter(record => record.byteExactMatch === true).length, parentBoundaryMatchedCount: records.filter(record => record.parentOnlyBoundaryPresent === true).length, headerOnlyBlocksExcluded, opaqueBlocksExcluded,
      countingRule: 'Each readable input_text block of a response_item:agent_message is checked against its own source-associated subagent item. Transport-only headers and opaque blocks do not count as readable returns; no global text deduplication.', records } };
};

async function main(): Promise<void> {
  for (const sample of samples) {
    const text = (await readFile(sample.file, 'utf8')).split('\n').slice(0, sample.lines).join('\n') + '\n';
    required(sha256(text) === sample.hash, `${sample.name}: fixed source hash changed; no historical baseline reused.`);
    loaded.set(sample.name, { sample, rows: text.trimEnd().split('\n').map(line => object(JSON.parse(line))), normalized: (sample.provider === 'codex' ? parseCodex : parseClaude)({ text, file: sample.file, projectPath }) });
  }

  const cxRequest = { line: 1245, block: 1, field: 'payload.content[0].text / ## My request' };
  run('CX2', 'codex-user-request', 'user-request', cxRequest, data => {
    const text = string(object(array(payload(data, 1245).content)[0]).text);
    const separator = '\n## My request:\n'; const split = text.indexOf(separator);
    required(split >= 0, 'The fixed IDE-context message has no request delimiter.');
    return exactText(data, cxRequest, text.slice(split + separator.length).trim(), 'request', '用户请求');
  });
  const cxBackground = { ...cxRequest, field: 'payload.content[0].text / IDE context before request' };
  run('CX2', 'codex-ide-background', 'request-background', cxBackground, data => {
    const text = string(object(array(payload(data, 1245).content)[0]).text); const split = text.indexOf('\n## My request:\n');
    required(split >= 0, 'The fixed IDE-context message has no request delimiter.');
    return exactText(data, cxBackground, text.slice(0, split).trim(), 'request', '随请求附带的 IDE 背景');
  });
  for (const [line, id, kind] of [[1248, 'codex-public-commentary', 'message'], [1279, 'codex-answer-with-memory-citation', 'answer']] as const) {
    const source = { line, block: 1, field: 'payload.content[0].text' };
    run('CX2', id, kind === 'answer' ? 'historical-answer' : 'public-process', source, data => exactText(data, source, string(object(array(payload(data, line).content)[0]).text), kind));
  }
  const cxInput = { line: 31, field: 'payload.arguments', callId: string(payload(loaded.get('CX2')!, 31).call_id), relatedLines: [34] };
  run('CX2', 'codex-tool-input-and-call-association', 'tool-input', cxInput, data => {
    const result = exactText(data, cxInput, string(payload(data, 31).arguments), 'tool'); const item = itemAt(data, cxInput, 'tool');
    const sourceAssociation = payload(data, 31).call_id === payload(data, 34).call_id && item.sources.some(s => s.line === 34);
    return { ...result, passed: result.passed && sourceAssociation, metadata: { ...result.metadata, callAssociationMatched: sourceAssociation } };
  });
  for (const index of [1, 2]) {
    const source = { line: 34, block: index, field: `payload.output[${index - 1}].text`, callId: cxInput.callId, relatedLines: [31] };
    run('CX2', `codex-tool-output-block-${index}`, 'tool-output', source, data => exactText(data, source, string(object(array(payload(data, 34).output)[index - 1]).text), 'tool'));
  }
  const cxCuaError = { line: 547, block: 1, field: 'payload.result.Ok.content[0].text', callId: string(payload(loaded.get('CX2')!, 547).call_id), relatedLines: [548] };
  run('CX2', 'codex-cua-error-without-runtime-instructions', 'tool-output', cxCuaError, data => {
    const result = exactText(data, cxCuaError, string(object(array(object(object(payload(data, 547).result).Ok).content)[0]).text), 'tool');
    return { ...result, passed: result.passed && itemAt(data, cxCuaError, 'tool').status === 'failed', metadata: { ...result.metadata, normalizedStatus: itemAt(data, cxCuaError, 'tool').status } };
  });
  const cxCuaDocs = { line: 547, block: 2, field: 'payload.result.Ok.content[1].text / response mirror payload.output[2].text', callId: cxCuaError.callId, relatedLines: [548] };
  run('CX2', 'codex-runtime-document-and-mirror-exclusion', 'runtime-context-exclusion', cxCuaDocs, data => {
    const doc = string(object(array(object(object(payload(data, 547).result).Ok).content)[1]).text);
    const mirrored = string(object(array(payload(data, 548).output)[2]).text);
    const item = itemAt(data, cxCuaDocs, 'tool');
    const sourceExcluded = data.normalized.coverage.some(c => c.source.line === 547 && c.source.block === 2 && c.kind === 'cua:runtime-instructions' && c.disposition === 'excluded');
    const mirrorExcluded = data.normalized.coverage.some(c => c.source.line === 548 && c.source.block === 3 && c.kind === 'cua:runtime-instructions' && c.disposition === 'excluded');
    const copied = item.detail?.blocks.some(b => b.text?.includes(doc)) ?? false;
    return { comparison: 'recognized-runtime-block-exclusion-with-source-identity', passed: doc === mirrored && sourceExcluded && mirrorExcluded && !copied, metadata: { itemId: item.id, sourceSha256: sha256(doc), mirrorSha256: sha256(mirrored), sourceUtf8Bytes: Buffer.byteLength(doc), sourceExcluded, mirrorExcluded, copiedToDetail: copied } };
  });
  const cxPatch = { line: 427, field: 'payload.changes[*].unified_diff', callId: string(payload(loaded.get('CX2')!, 427).call_id) };
  run('CX2', 'codex-historical-patch', 'historical-patch', cxPatch, data => {
    const source = payload(data, 427); const changes = Object.entries(object(source.changes)); const item = itemAt(data, cxPatch, 'file-change');
    const expected = changes.map(([path, change]) => ({ path, diff: string(object(change).unified_diff) }));
    const matches = expected.every(change => item.detail?.blocks.some(b => b.kind === 'patch' && b.label === change.path && b.text === change.diff));
    return { comparison: 'exact-historical-patch-text-path-and-source-status', passed: matches && source.success === true && item.status === 'completed' && !!item.detail?.provenance?.includes('不是当前 Git diff'), metadata: { itemId: item.id, fileCount: expected.length, expectedPatchSha256: expected.map(e => sha256(e.diff)), expectedPathSha256: expected.map(e => sha256(e.path)), normalizedPatchSha256: item.detail?.blocks.filter(b => b.kind === 'patch').map(b => sha256(b.text ?? '')), status: item.status, sourceSuccess: source.success, historicalBoundaryPresent: !!item.detail?.provenance?.includes('不是当前 Git diff') } };
  });
  const cxAdded = { line: 446, field: 'payload.item.changes[*].content' };
  run('CX1', 'codex-old-format-added-file-evidence', 'historical-patch', cxAdded, data => {
    const changes = Object.values(object(object(payload(data, 446).item).changes)); required(changes.length === 1, 'Fixed old-format file change is not singular.');
    const result = exactText(data, cxAdded, string(object(changes[0]).content), 'file-change');
    return { ...result, metadata: { ...result.metadata, sourceChangeType: object(changes[0]).type } };
  });
  const cxImage = { line: 588, block: 3, field: 'payload.output[2].image_url', callId: string(payload(loaded.get('CX2')!, 588).call_id) };
  run('CX2', 'codex-inline-image-mirror', 'inline-image', cxImage, data => {
    const uri = string(object(array(payload(data, 588).output)[2]).image_url); const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(uri);
    required(match, 'Expected fixed image data URL is missing.'); return exactImage(data, cxImage, match![2], match![1]);
  });
  const cxChild = { line: 161, block: 1, field: 'payload.content[0].text' };
  run('CX2', 'codex-readable-subagent-return', 'subagent-return', cxChild, data => {
    const result = exactText(data, cxChild, string(object(array(payload(data, 161).content)[0]).text), 'subagent'); const item = itemAt(data, cxChild, 'subagent');
    return { ...result, passed: result.passed && !!item.detail?.notice?.includes('不代表子 Agent 内部过程完整'), metadata: { ...result.metadata, parentOnlyBoundaryPresent: !!item.detail?.notice?.includes('不代表子 Agent 内部过程完整') } };
  });

  for (const [sample, line] of [['CL1', 10], ['CL2', 5]] as const) {
    const source = { line, field: 'message.content' };
    run(sample, `${sample.toLowerCase()}-user-request`, 'user-request', source, data => exactText(data, source, string(object(row(data, line).message).content), 'request'));
  }
  for (const [sample, line, expectedCount] of [['CL1', 42, 8], ['CL2', 17, 1]] as const) {
    const source = { line, block: 1, field: 'message.content[0].content[*].tool_name' };
    run(sample, `${sample.toLowerCase()}-tool-search-reference-names`, 'tool-output-metadata', source, data => {
      const expected = array(block(data, line).content).map(value => {
        const reference = object(value);
        required(reference.type === 'tool_reference' && Object.keys(reference).sort().join(',') === 'tool_name,type', 'Fixed tool reference schema changed.');
        return string(reference.tool_name);
      });
      const item = itemAt(data, source, 'tool');
      const actual = item.detail?.blocks.filter(value => value.label === 'ToolSearch 返回的工具引用（不代表调用）').map(value => value.text) ?? [];
      const matched = expected.length === expectedCount && canonical(expected) === canonical(actual);
      return { comparison: 'all-fixed-tool-reference-names-exact-text-and-order', passed: item.title === 'ToolSearch' && matched && item.availability === 'available', metadata: { itemId: item.id, expectedCount, sourceCount: expected.length, normalizedCount: actual.length, expectedSha256: expected.map(sha256), normalizedSha256: actual.map(value => sha256(value ?? '')), referencesOnly: true, loadedDefinitions: false } };
    });
  }
  for (const [sample, line, id, kind] of [['CL2', 36, 'claude-public-process', 'message'], ['CL1', 247, 'claude-old-format-answer', 'answer'], ['CL2', 235, 'claude-historical-answer', 'answer'], ['CL2-child', 21, 'claude-child-saved-return', 'answer']] as const) {
    const source = { line, block: 1, field: 'message.content[0].text' };
    run(sample, id, sample === 'CL2-child' ? 'subagent-return' : kind === 'answer' ? 'historical-answer' : 'public-process', source, data => exactText(data, source, string(block(data, line).text), kind));
  }
  const clInput = { line: 19, block: 1, field: 'message.content[0].input', callId: string(block(loaded.get('CL1')!, 19).id), relatedLines: [20] };
  run('CL1', 'claude-bash-input-structure', 'tool-input', clInput, data => {
    const result = exactStructure(data, clInput, block(data, 19).input, '当时调用参数'); const item = itemAt(data, clInput, 'tool');
    const paired = block(data, 19).id === block(data, 20).tool_use_id && item.sources.some(s => s.line === 20);
    return { ...result, passed: result.passed && paired, metadata: { ...result.metadata, callAssociationMatched: paired } };
  });
  for (const [line, id] of [[44, 'claude-chrome-tabs-input-structure'], [116, 'claude-chrome-zoom-input-structure']] as const) {
    const source = { line, block: 1, field: 'message.content[0].input', callId: string(block(loaded.get('CL1')!, line).id) };
    run('CL1', id, 'tool-input', source, data => exactStructure(data, source, block(data, line).input, '当时调用参数'));
  }
  const clOutput = { line: 20, block: 1, field: 'message.content[0].content', callId: clInput.callId, relatedLines: [19] };
  run('CL1', 'claude-bash-output-text', 'tool-output', clOutput, data => exactText(data, clOutput, string(block(data, 20).content), 'tool'));
  const clError = { line: 117, block: 1, field: 'message.content[0].content / is_error', callId: string(block(loaded.get('CL1')!, 117).tool_use_id) };
  run('CL1', 'claude-tool-denial-error-evidence', 'tool-output', clError, data => {
    const result = exactText(data, clError, string(block(data, 117).content), 'tool'); const item = itemAt(data, clError, 'tool');
    return { ...result, passed: result.passed && block(data, 117).is_error === true && item.status === 'failed', metadata: { ...result.metadata, sourceIsError: block(data, 117).is_error, normalizedStatus: item.status } };
  });
  const clQuestion = { line: 37, block: 1, field: 'message.content[0].input', callId: string(block(loaded.get('CL2')!, 37).id), relatedLines: [38] };
  run('CL2', 'claude-structured-question-and-options', 'structured-question', clQuestion, data => exactStructure(data, clQuestion, block(data, 37).input, '当时调用参数'));
  const clAnswers = { line: 38, block: 1, field: 'toolUseResult.questions / answers / annotations', callId: clQuestion.callId, relatedLines: [37] };
  run('CL2', 'claude-recorded-answers-and-annotations', 'structured-question', clAnswers, data => {
    const source = object(row(data, 38).toolUseResult);
    return exactStructure(data, clAnswers, { questions: source.questions, answers: source.answers, annotations: source.annotations }, '问题及记录的回答');
  });
  const clImage = { line: 55, block: 1, nestedBlock: 1, field: 'message.content[0].content[0].source', callId: string(block(loaded.get('CL1')!, 55).tool_use_id) };
  run('CL1', 'claude-inline-image-bytes', 'inline-image', clImage, data => {
    const source = object(object(array(block(data, 55).content)[0]).source);
    required(source.type === 'base64', 'Selected image is not embedded base64.'); return exactImage(data, clImage, string(source.data), string(source.media_type));
  });
  for (const [sample, line] of [['CL1', 1087], ['CL2', 195]] as const) {
    const source = { line, field: 'attachment.filename / snippet' };
    run(sample, `${sample.toLowerCase()}-historical-file-snippet`, 'historical-file-fragment', source, data => {
      const attachment = object(row(data, line).attachment); const result = exactText(data, source, string(attachment.snippet), 'file-change'); const item = itemAt(data, source, 'file-change');
      return { ...result, passed: result.passed && item.summary === attachment.filename && item.availability === 'partial' && !!item.detail?.notice?.includes('不是完整文件历史'), metadata: { ...result.metadata, pathSha256: sha256(string(attachment.filename)), pathMatched: item.summary === attachment.filename, historicalFragmentBoundaryPresent: !!item.detail?.notice?.includes('不是完整文件历史') } };
    });
  }
  const clAgentLaunch = { line: 181, block: 1, nestedBlock: 1, field: 'toolUseResult.status / isAsync; recognized text wrapper excluded', callId: string(block(loaded.get('CL2')!, 181).tool_use_id), relatedLines: [180, 203] };
  run('CL2', 'claude-parent-agent-launch-state-and-runtime-exclusion', 'subagent-lifecycle', clAgentLaunch, data => {
    const source = object(row(data, 181).toolUseResult); const wrapper = string(object(array(block(data, 181).content)[0]).text);
    const result = exactStructure(data, clAgentLaunch, { status: source.status, isAsync: source.isAsync }, '当时异步启动状态');
    const item = itemAt(data, clAgentLaunch, 'subagent');
    const excluded = data.normalized.coverage.some(c => c.source.line === 181 && c.source.block === 1 && c.kind.startsWith('tool_result:async-launch-runtime-wrapper') && c.disposition === 'excluded');
    const copied = item.detail?.blocks.some(b => b.text?.includes(wrapper)) ?? false;
    const joined = item.sources.some(s => s.line === 180) && item.sources.some(s => s.line === 203);
    return { ...result, passed: result.passed && source.isAsync === true && source.status === 'async_launched' && excluded && !copied && joined, metadata: { ...result.metadata, wrapperSha256: sha256(wrapper), wrapperUtf8Bytes: Buffer.byteLength(wrapper), wrapperExcluded: excluded, wrapperCopiedToDetail: copied, launchAndCompletionAssociationRetained: joined } };
  });
  const clAgentReturn = { line: 203, field: 'message.content / task-notification', callId: clAgentLaunch.callId, relatedLines: [180, 181] };
  run('CL2', 'claude-parent-task-notification-return', 'subagent-return', clAgentReturn, data => {
    const result = exactText(data, clAgentReturn, string(object(row(data, 203).message).content), 'subagent'); const item = itemAt(data, clAgentReturn, 'subagent');
    const joined = item.sources.some(s => s.line === 180) && item.sources.some(s => s.line === 181);
    return { ...result, passed: result.passed && joined && item.status === 'completed' && !!item.detail?.notice?.includes('子任务内部过程'), metadata: { ...result.metadata, launchAndNotificationShareItem: joined, normalizedStatus: item.status, parentOnlyBoundaryPresent: !!item.detail?.notice?.includes('子任务内部过程') } };
  });

  for (const [sample, expectedCount] of [['CX1', 35], ['CX2', 24], ['CL1', 49]] as const) {
    run(sample, `${sample.toLowerCase()}-all-response-inline-images`, 'inline-image-batch', { line: 1, field: 'all embedded image blocks in fixed response-side tool results; individual origins in metadata.records' }, data => allEmbeddedImages(data, expectedCount));
  }
  run('CX2', 'codex-all-readable-subagent-returns', 'subagent-return-batch', { line: 1, field: 'all public response_item:agent_message input_text blocks in the fixed sample; individual origins in metadata.records' }, allPublicCodexSubagentReturns);

  const failed = checks.filter(check => !check.passed);
  const batchSummary = checks.filter(check => check.category.endsWith('-batch')).map(check => ({ id: check.id, sample: check.sample, category: check.category, sourceRecordCount: check.metadata.sourceRecordCount, contentBlockCount: check.metadata.contentBlockCount, byteExactMatchedCount: check.metadata.byteExactMatchedCount, passed: check.passed }));
  const report = { kind: 'fixed-real-source-to-normalized-content-checks', generatedAt: new Date().toISOString(), scope: 'Selected exact fields plus exhaustive fixed response-inline-image/public-Codex-subagent-text categories, not every field or original UI.',
    limitations: ['This script does not render a Webview, operate original Agent UI, or establish pixel/DOM fidelity.', 'CL2-child is checked independently; this does not establish parent-child loading in the product.', 'Sources and hashes are metadata only; no raw text, arguments, output, questions, answers, patch bodies, or image bytes are written.'],
    samples: samples.map(s => ({ name: s.name, provider: s.provider, file: s.file, lines: s.lines, sha256: s.hash })), checkCount: checks.length, passed: checks.length - failed.length, failed: failed.length, batchSummary, checks };
  await mkdir('.test-artifacts', { recursive: true });
  await writeFile('.test-artifacts/real-content-checks.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ kind: report.kind, checkCount: checks.length, passed: report.passed, failed: report.failed, batchSummary, failures: failed.map(c => ({ id: c.id, sample: c.sample, source: c.source, metadata: c.category.endsWith('-batch') ? { error: c.metadata.error, contentBlockCount: c.metadata.contentBlockCount, byteExactMatchedCount: c.metadata.byteExactMatchedCount, multiplicityMismatchCount: c.metadata.multiplicityMismatchCount } : c.metadata })), artifact: '.test-artifacts/real-content-checks.json' }, null, 2));
  if (failed.length) process.exitCode = 1;
}
void main().catch(async () => {
  const message = 'Real-content verification could not finish: fixed sample or expected source structure is unavailable. No raw source was emitted.';
  // Replace a previous passing report after setup failure so it cannot be read
  // as evidence for this run. The failure path also emits no raw source.
  try {
    await mkdir('.test-artifacts', { recursive: true });
    await writeFile('.test-artifacts/real-content-checks.json', JSON.stringify({ kind: 'fixed-real-source-to-normalized-content-checks', generatedAt: new Date().toISOString(), passed: 0, failed: 1, setupFailure: message }, null, 2) + '\n');
  } catch { /* The command still fails if the report location is unavailable. */ }
  console.error(message); process.exitCode = 1;
});
