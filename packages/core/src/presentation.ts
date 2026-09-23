import { describeAction, recordedToolInputs, shellReadRange, type ActionDescription, type ActionEntry } from './actions';
import { createHash } from 'node:crypto';
import type { EvidenceBlock, TimelineItem } from './model';
import { toolView, webInputRows } from './tool-view';

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const inputLabels = new Set(['记录中的调用参数', '当时调用参数', '当时命令', '后续读取调用', '同一调用 ID 的另一组记录参数']);
const outputLabels = new Set(['当时返回的内容', 'MCP 当时返回的内容', '当时返回', '记录的 stdout', '记录的 stderr（不单独判定失败）']);
export const publicLabels = new Set(['正文', '公开正文', '用户请求', '用户请求或公开正文', '先前公开文本块', '后续公开文本块', '子 Agent 返回']);
export interface CodeContent { kind: 'code'; text: string; language?: string; label?: string }
export interface DiffContent { kind: 'diff'; files: PatchFile[] }
export interface PatchFile { path: string; operation: 'add' | 'update' | 'delete' | 'write'; moveTo?: string; lines: string[] }
export interface FieldContent { kind: 'fields'; rows: Array<[string, string]> }
export type InputContent = CodeContent | DiffContent | FieldContent;

/** Only parse the recorded patch; never read a current file or invent line numbers. */
export function parsePatch(source: string): PatchFile[] | undefined {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch' && lines.at(-2)?.trim() !== '*** End Patch') return undefined;
  const files: PatchFile[] = [];
  for (const line of lines.slice(1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) { files.push({ path: header[2], operation: header[1].toLowerCase() as PatchFile['operation'], lines: [] }); continue; }
    if (line === '*** End Patch' || line === '*** End of File' || !line && !files.length) continue;
    const file = files.at(-1);
    if (!file) return undefined;
    if (line.startsWith('*** Move to: ')) file.moveTo = line.slice(13);
    else if (!line || /^[ +\-]/.test(line) || line.startsWith('@@')) file.lines.push(line);
    else return undefined;
  }
  return files.length ? files : undefined;
}

export function invocationInput(name: string, input: unknown): InputContent[] {
  const args = obj(input);
  if (['get_goal', 'create_goal', 'update_goal'].includes(name)) return Object.keys(args).length ? [structuredFields(args)] : [];
  if (/^mcp__(?:cua_repl|node_repl)(?:__|\.)js$/.test(name) && typeof args.code === 'string') {
    const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'code' && key !== 'title'));
    return [{ kind: 'code', text: args.code, language: 'javascript' }, ...(Object.keys(extra).length ? [{ kind: 'code' as const, text: JSON.stringify(extra, null, 2), language: 'json', label: '参数' }] : [])];
  }
  if (['web__run', 'web.run'].includes(name)) {
    const rows = webInputRows(input);
    if (rows.length) return [{ kind: 'fields', rows }, { kind: 'code', text: JSON.stringify(input, null, 2), language: 'json', label: '完整参数' }];
  }
  if (['Read', 'Skill', 'WebSearch', 'WebFetch', 'Grep', 'Glob', 'ToolSearch'].includes(name) || /^mcp__/.test(name)) {
    if (Object.keys(args).length) return [structuredFields(args)];
  }
  if (['exec_command', 'Bash'].includes(name) && (typeof args.cmd === 'string' || typeof args.command === 'string')) {
    const commandKey = typeof args.cmd === 'string' ? 'cmd' : 'command';
    const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== commandKey));
    return [{ kind: 'code', text: String(args[commandKey]), language: 'bash' }, ...(Object.keys(extra).length ? [{ kind: 'code' as const, text: JSON.stringify(extra, null, 2), language: 'json', label: '参数' }] : [])];
  }
  if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : text(args.patch);
    const files = parsePatch(patch);
    if (files) return [{ kind: 'diff', files }];
    return [{ kind: 'code', text: patch || JSON.stringify(input, null, 2) || '', language: 'diff' }];
  }
  if (name === 'Write' && typeof args.file_path === 'string' && typeof args.content === 'string') {
    return [{ kind: 'diff', files: [{ path: args.file_path, operation: 'write', lines: args.content.split('\n') }] }];
  }
  if (name === 'Edit' && typeof args.file_path === 'string' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !['file_path', 'old_string', 'new_string'].includes(key)));
    return [{ kind: 'diff', files: [{ path: args.file_path, operation: 'update', lines: [...args.old_string.split('\n').map(line => '-' + line), ...args.new_string.split('\n').map(line => '+' + line)] }] },
      ...(Object.keys(rest).length ? [{ kind: 'code' as const, text: JSON.stringify(rest, null, 2), language: 'json', label: '参数' }] : [])];
  }
  return [{ kind: 'code', text: typeof input === 'string' ? input : JSON.stringify(input, null, 2) || '', language: name === 'exec' ? 'javascript' : typeof input === 'string' ? undefined : 'json' }];
}

const fieldNames: Record<string, string> = { objective: '目标', status: '状态', token_budget: 'Token 预算', file_path: '路径', path: '路径', offset: '起始位置', limit: '数量', query: '查询', pattern: '匹配', skill: '技能', args: '参数', url: 'URL', title: '标题', description: '描述' };
function structuredFields(args: Record<string, unknown>): FieldContent {
  return { kind: 'fields', rows: Object.entries(args).map(([key, value]) => [fieldNames[key] ?? key, typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '']) };
}

/** Known goal records get a field reader; other outputs retain literal code. */
export function toolOutputContents(item: TimelineItem, source: string): InputContent[] {
  const calls = recordedToolInputs(item);
  if (calls.length === 1 && ['get_goal', 'create_goal', 'update_goal'].includes(calls[0].name)) {
    try { const value: unknown = JSON.parse(source); if (value && typeof value === 'object' && !Array.isArray(value)) return [structuredFields(obj(value))]; } catch { /* Incomplete output stays readable while streaming. */ }
  }
  try { return [{ kind: 'code', text: JSON.stringify(JSON.parse(source), null, 2), language: 'json' }]; } catch { return [{ kind: 'code', text: source }]; }
}

/** Share grounded operation names across the narrow rail and evidence readers. */
export function describeDisplayAction(item: TimelineItem): ActionDescription {
  if (item.title === 'Web 来源') return describeAction(item);
  const calls = recordedToolInputs(item);
  if (!calls.length) {
    const previous = describeAction(item);
    if (item.kind === 'tool' && item.title !== 'Web 来源') {
      const view = toolView(item.title, undefined);
      return { ...previous, label: [view.name, view.label].filter(Boolean).join(' · '), entries: previous.entries.map(entry => ({ ...entry, toolName: view.name, label: view.label, displayType: view.type })) };
    }
    return item.kind === 'file-change' ? { ...previous, entries: previous.entries.map(entry => ({ ...entry, toolName: 'Write', displayType: 'WRITE' })) } : previous;
  }
  const entries: ActionEntry[] = [];
  for (const [index, call] of calls.entries()) {
    const view = toolView(call.name, call.input);
    const name = view.name;
    const synthetic = { ...item, title: call.name, detail: { title: call.name, blocks: [{ kind: 'code' as const, label: '记录中的调用参数', text: typeof call.input === 'string' ? call.input : JSON.stringify(call.input) }] } };
    const semantic = describeAction(synthetic);
    const targets = view.paths ?? semantic.targets;
    const label = call.name === 'apply_patch' ? targets?.map(path => path.replace(/\\/g, '/').split('/').at(-1)).join('、') || '文件修改'
      : view.label;
    const key = JSON.stringify(['invocation', name, call.input, index]);
    const previous = entries.find(entry => entry.key === key);
    if (previous) previous.count++;
    else entries.push({ key, label, count: 1, toolName: name, displayType: view.type, ...(targets ? { targets } : {}) });
  }
  return { label: entries.map(entry => [entry.toolName, entry.label].filter(Boolean).join(' · ')).join('；'), key: JSON.stringify(entries.map(entry => [entry.key, entry.count])), entries,
    ...(calls.some(call => call.name === 'exec') ? { unresolved: true } : {}) };
}

/** File entries use recorded content only; full paths stay in evidence, not the rail. */
export function recordedFiles(items: TimelineItem[], entry?: ActionEntry): PatchFile[] {
  if (entry?.key.startsWith('["invocation",')) {
    const [, , input, index] = JSON.parse(entry.key);
    const call = recordedToolInputs(items[0])[index ?? 0];
    if (call && JSON.stringify(call.input) === JSON.stringify(input)) {
      const files = invocationInput(call.name, call.input).flatMap(c => c.kind === 'diff' ? c.files : []);
      if (files.length) return files;
    }
  }
  return items.flatMap(item => {
    const files = presentEvidence(item).calls.flatMap(call => call.contents.flatMap(c => c.kind === 'diff' ? c.files : []));
    if (files.length) return files;
    if (item.kind !== 'file-change') return [];
    return (item.detail?.blocks ?? []).flatMap(block => {
      if (block.kind === 'patch') return parsePatch(block.text ?? '') ?? [{ path: block.label, operation: 'update' as const, lines: (block.text ?? '').split('\n') }];
      const content = /^(.*) · 当时(新增|删除)内容$/.exec(block.label);
      return block.kind === 'code' && content ? [{ path: content[1], operation: content[2] === '新增' ? 'add' as const : 'delete' as const, lines: (block.text ?? '').split('\n').map(line => (content[2] === '新增' ? '+' : '-') + line) }] : [];
    });
  });
}
export const fileEvidenceId = (rowId: string, index: number, path: string): string => 'write-file:' + createHash('sha256').update(JSON.stringify([rowId, index, path])).digest('hex');
export function shortFileLabels(paths: string[]): string[] {
  const segments = paths.map(path => path.replace(/\\/g, '/').split('/').filter(Boolean));
  return segments.map((parts, i) => {
    let length = 1;
    while (length < parts.length && segments.some((other, j) => j !== i && paths[j] !== paths[i] && other.slice(-length).join('/') === parts.slice(-length).join('/'))) length++;
    return parts.slice(-length).join('/');
  });
}

/** Remove only a recognized transport prefix at the beginning, not stdout prose. */
export function decodeTransport(source: string, name: string): string {
  if (!/^(?:functions[/.])?(?:exec|wait|exec_command|write_stdin)$/.test(name) && name !== '命令执行记录') return source;
  const lines = source.split(/\r?\n/); let header = false;
  for (const [index, line] of lines.entries()) {
    if (header && /^(?:Output:|Final output:)\s*$/.test(line)) return lines.slice(index + 1).join('\n');
    if (/^(?:Chunk ID:|Wall time(?::| )|Process exited with code -?\d+\s*$|Original token count:|Warning: truncated output|Script (?:completed|failed|terminated|running with cell ID \S+))/.test(line)) header = true;
    else if (line.trim()) break;
  }
  return source;
}

// A complete stream of known command result objects. Never interpret arbitrary
// JSON printed by an unrelated tool, and never pair by array position.
function commandEnvelopes(source: string): string[] | undefined {
  const values: unknown[] = []; let start = 0; let depth = 0; let quoted = false; let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (!depth) { if (/\s/.test(char)) continue; if (char !== '{') return undefined; start = i; }
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { depth--; if (!depth) { try { values.push(JSON.parse(source.slice(start, i + 1))); } catch { return undefined; } } }
  }
  if (depth || quoted || !values.length) return undefined;
  const metadata = new Set(['output', 'exit_code', 'session_id', 'chunk_id', 'wall_time_seconds', 'original_token_count']);
  if (!values.every(value => { const data = obj(value); return typeof data.output === 'string' && typeof data.wall_time_seconds === 'number' && typeof data.chunk_id === 'string' && Object.keys(data).every(key => metadata.has(key)); })) return undefined;
  return values.map(value => String(obj(value).output));
}

export interface EvidencePresentation { calls: Array<{ name: string; contents: InputContent[] }>; outputs: EvidenceBlock[]; other: EvidenceBlock[] }
export function presentEvidence(item: TimelineItem): EvidencePresentation {
  const calls = recordedToolInputs(item);
  const shellWrapper = /^(?:functions[/.])?exec$/.test(item.title) && calls.some(call => ['exec_command', 'write_stdin'].includes(call.name));
  const outputs: EvidenceBlock[] = [], other: EvidenceBlock[] = [];
  for (const block of item.detail?.blocks ?? []) {
    if (calls.length && inputLabels.has(block.label) && ['code', 'json'].includes(block.kind)) {
      // Follow-up and changed arguments are distinct input versions, not discarded.
      if (!['记录中的调用参数', '当时调用参数', '当时命令'].includes(block.label)) other.push(block);
      continue;
    }
    if (outputLabels.has(block.label) && item.title !== 'Web 来源' && ['text', 'code'].includes(block.kind)) {
      const body = decodeTransport(block.text ?? '', item.title);
      if (!body.trim()) continue;
      if (body.trim() === '{}' && calls.length && calls.every(call => call.name === 'apply_patch')) continue;
      const decoded = shellWrapper ? commandEnvelopes(body) : undefined;
      for (const text of decoded ?? [body]) if (text.trim()) outputs.push({ ...block, text, kind: 'code' });
    } else other.push(block);
  }
  return { calls: calls.map(call => ({ name: toolView(call.name, call.input).name, contents: invocationInput(call.name, call.input) })), outputs, other };
}

const languages: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', py: 'python', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash', md: 'markdown', markdown: 'markdown',
  css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', go: 'go', rs: 'rust', java: 'java',
  rb: 'ruby', sql: 'sql', toml: 'ini', ini: 'ini', diff: 'diff', patch: 'diff',
};
export const fileLanguage = (path: string): string | undefined => languages[/\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? ''];

export interface FileReading { path: string; lines: string[]; start?: number; language?: string }

/** `N<tab>` or `N→` on every line, counting up: the reader's own line numbers. */
function numberedLines(lines: string[]): { start: number; lines: string[] } | undefined {
  const parsed = lines.map(line => /^\s*(\d+)(?:\t|→)(.*)$/.exec(line));
  if (!parsed.length || parsed.some(match => !match)) return undefined;
  const start = Number(parsed[0]![1]);
  return parsed.every((match, index) => Number(match![1]) === start + index) ? { start, lines: parsed.map(match => match![2]) } : undefined;
}

/**
 * A read of one file, shown as that file: the text the session recorded, with
 * line numbers only when the reader or its own arguments give them. This is the
 * content at the time, never the current file on disk.
 */
export function fileReading(item: TimelineItem): FileReading | undefined {
  const calls = recordedToolInputs(item);
  if (calls.length !== 1 || item.status === 'failed') return undefined;
  const name = calls[0].name.replace(/^functions[./]/, ''), args = obj(calls[0].input);
  const range = name === 'Read' && typeof args.file_path === 'string' ? { path: args.file_path }
    : ['Bash', 'exec_command'].includes(name) ? shellReadRange(text(args.command) || text(args.cmd)) : undefined;
  if (!range) return undefined;
  const output = presentEvidence(item).outputs.map(block => block.text ?? '').join('\n').replace(/\n$/, '');
  if (!output.trim()) return undefined;
  const lines = output.split('\n'), numbered = numberedLines(lines);
  const start = numbered?.start ?? ('start' in range ? range.start : undefined);
  return { path: range.path, lines: numbered?.lines ?? lines, ...(start !== undefined ? { start } : {}), ...(fileLanguage(range.path) ? { language: fileLanguage(range.path) } : {}) };
}
