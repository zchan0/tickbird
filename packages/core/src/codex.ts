import type { CoverageRecord, EvidenceBlock, ItemKind, ItemStatus, ParseInput, SessionData, SourceRef, TimelineItem } from './model';
import { interruptionPlaceholder, parseSnapshot, sourceTimestamp, type ParserContext, type SessionParser } from './jsonl';
import { recordedToolInputs, shellArgvScript } from './actions';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parsePatch } from './presentation';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const textBlock = (label: string, text: string, kind: EvidenceBlock['kind'] = 'text'): EvidenceBlock => ({ kind, label, text });
const short = (text: string): string => text.length > 180 ? `${text.slice(0, 180)}…` : text;
const parseObject = (value: unknown): Obj => {
  if (typeof value !== 'string') return obj(value);
  try { return obj(JSON.parse(value)); } catch { return {}; }
};
type ObservedResult = Exclude<TimelineItem['result'], undefined | 'not-observed'>;
type Transport = 'script' | 'command';
const transportFor = (item: TimelineItem): Transport | undefined => /^(?:functions[/.])?(?:exec|wait)$/.test(item.title) ? 'script' : /^(?:functions[/.])?(?:exec_command|write_stdin)$/.test(item.title) || item.title === '命令执行记录' ? 'command' : undefined;
const transportLine = (line: string, transport: Transport): boolean => /^(?:Chunk ID:|Wall time(?::| )|Process exited with code -?\d+|Original token count:|Warning: truncated output)/.test(line) || (transport === 'script' && /^Script (?:completed|failed|terminated|running with cell ID \S+)/.test(line));
const returnedText = (text: string, transport: Transport): string => {
  const lines = text.split(/\r?\n/); let header = false;
  for (const [index, line] of lines.entries()) {
    if (header && /^(?:Output:|Final output:)\s*$/.test(line)) return lines.slice(index + 1).join('\n');
    if (transportLine(line, transport)) header = true;
    else if (line.trim()) break;
  }
  return text;
};
const observeResult = (item: TimelineItem, result: ObservedResult): void => {
  const previous = item.result;
  if (!previous || previous === 'not-observed' || previous === 'empty') item.result = result;
  else if (result !== 'empty' && result !== previous) item.result = 'partial';
};
// Only explicit empty content in an already supported return schema is empty.
// Missing bodies, opaque objects and excluded private blocks are not empty output.
const emptyReturn = (value: unknown, transport?: Transport): boolean => {
  if (typeof value === 'string') return !(transport ? returnedText(value, transport) : value).trim();
  if (Array.isArray(value)) return value.every(v => {
    const b = obj(v);
    return ['input_text', 'output_text', 'text', 'Text'].includes(str(b.type)) && typeof b.text === 'string' && !(transport ? returnedText(b.text, transport) : b.text).trim();
  });
  const o = obj(value);
  if (Array.isArray(o.content)) return emptyReturn(o.content);
  if (typeof o.output === 'string') return !o.output.trim();
  if (typeof o.task_name === 'string') return !o.task_name.trim();
  return Array.isArray(o.agents) && o.agents.length === 0;
};
const hiddenBlock = (type: string): boolean => /^(reasoning|Reasoning|analysis|encrypted_content|thinking|redacted_thinking)$/.test(type);
const injection = (text: string): boolean => /^\s*(?:<(?:environment_context|codex_internal_context|permissions(?:_| )instructions|collaboration_mode|skills_instructions|skill|recommended_plugins|user_instructions|system_reminder|turn_aborted)\b|# AGENTS\.md instructions(?: for\b|[ \t]*\r?\n\s*<INSTRUCTIONS>))/.test(text);
// Codex's IDE extension and app put what goes with a request first, under their own
// headings (the open tabs, the files the user mentioned, a ChatGPT conversation), and
// the request after "## My request:".
const CONTEXT_HEAD = /^(?:# Context from my IDE setup:|# Files mentioned by the user:|## Referenced ChatGPT conversation:|<in-app-browser-context\b)/m;
// The app's browser state, sent with each request; not the user's words.
const BROWSER_STATE = /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/g;
// A pasted image goes as its own block between these two; the tags only name it.
const imageWrapper = (text: string): boolean => /^\s*(?:<image name=[^\n]*>|<\/image>)\s*$/.test(text);
/** An answer to a question this record does not hold (asked from a script, say): the questions and the answers, without the transport tags. */
const unmatchedReply = (raw: string): string | undefined => {
  const body = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(raw)?.[1];
  if (body === undefined) return undefined;
  try {
    const replies = JSON.parse(body);
    if (!Array.isArray(replies) || !replies.length) return undefined;
    return replies.map(obj).map(reply => [str(reply.question), `→ ${str(reply.answer)}`].filter(line => line.trim() && line !== '→ ').join('\n')).join('\n\n') || undefined;
  } catch { return undefined; }
};
/** A command the user ran with `!`: the command and what it printed, for the agent to see. */
const userShellCommand = (raw: string): { command: string; result: string } | undefined => {
  const match = /^\s*<user_shell_command>\s*<command>\r?\n?([\s\S]*?)\r?\n?<\/command>\s*(?:<result>\r?\n?([\s\S]*?)\s*<\/result>\s*)?<\/user_shell_command>\s*$/.exec(raw);
  return match && match[1].trim() ? { command: match[1].trim(), result: match[2] ?? '' } : undefined;
};
const citeBody = (text: string): string => text.replace(/\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/, '').trim();
// Only the standalone, identified CUA bootstrap document is internal runtime
// context. Quoted text, ordinary tool output and mixed documentation/UI blocks
// must not be removed by keyword matching.
const cuaRuntimeDocument = (text: string): boolean =>
  text.startsWith('## Computer Use\n\nControl native apps and browsers on the user’s computer by reading or operating UI.') &&
  ['\n## API\n', '\n## Workflow\n', '\n# Computer/Browser Use Confirmation Policy\n', '\n## Confirmation Behavior Guidelines\n'].every(marker => text.includes(marker)) &&
  text.trimEnd().endsWith('- Repeat confirmations unless the action, destination, data, amount, permissions, legal terms, or risk materially changes.');
function rasterMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
}

interface RecordEntry { line: number; record: Obj; payload: Obj }
interface Mirror { line: number; spacerLine?: number; role: string; phase: string; channel: string; text: string; turn?: string; item: TimelineItem; citation: boolean }

/** Parse a supplied snapshot only. Never reads paths, runs calls, or resolves URLs from a transcript. */
export function parseCodex(input: ParseInput): SessionData {
  return parseSnapshot(input, 'codex', createCodexParser);
}

export function* createCodexParser(input: ParserContext): SessionParser {
  const data: SessionData = { id: input.sessionId, provider: 'codex', projectPath: input.projectPath, title: 'Codex session', items: [], coverage: [], warnings: [] };
  let turn: string | undefined;
  let activeTurn: string | undefined;
  let mirror: Mirror | undefined;
  const calls = new Map<string, TimelineItem>();
  const cells = new Map<string, TimelineItem>();
  const mcpResults = new Set<string>();
  const nativeMcpCalls = new Set<string>();
  const cuaCalls = new Set<string>();
  const compactions = new Map<string, TimelineItem>();
  const matchedPatchInputs = new Set<string>();
  const matchedCommandInputs = new Set<string>();
  // Both the JSONL line and content-block position are 1-based in the public model.
  const source = (entry: RecordEntry, block?: number): SourceRef => ({ file: input.file, line: entry.line, ...(str(entry.payload.id) ? { recordId: str(entry.payload.id) } : {}), ...(block === undefined ? {} : { block: block + 1 }) });
  const cover = (entry: RecordEntry, kind: string, disposition: CoverageRecord['disposition'], reason: string, item?: TimelineItem, block?: number): void => {
    data.coverage.push({ source: source(entry, block), kind, disposition, reason, ...(item ? { itemId: item.id } : {}) });
  };
  const add = (entry: RecordEntry, kind: ItemKind, title: string, summary: string, status: ItemStatus = 'info'): TimelineItem => {
    const item: TimelineItem = { id: `${data.id}:${entry.line}:${data.items.length}`, sessionId: data.id, ...(turn ? { turnId: turn } : {}), kind, title, summary, status, sources: [source(entry)], availability: 'none' };
    const timestamp = sourceTimestamp(entry.record.timestamp);
    if (timestamp) item.timestamp = timestamp;
    data.items.push(item);
    return item;
  };
  const append = (item: TimelineItem, blocks: EvidenceBlock[], notice?: string): void => {
    if (blocks.length) {
      item.detail ??= { title: item.title, blocks: [], provenance: '会话当时记录的内容；未读取当前文件，也未执行记录中的调用。' };
      item.detail.blocks.push(...blocks);
      // A provenance/scope notice is not by itself evidence of missing content.
      item.availability = item.availability === 'partial' ? 'partial' : 'available';
    }
    if (notice) {
      if (item.detail) item.detail.notice = [item.detail.notice, notice].filter(Boolean).join('\n');
      else item.availability = 'unavailable';
    }
  };
  const unsupported = (entry: RecordEntry, kind: string, reason: string): TimelineItem => {
    const item = add(entry, 'notice', `待支持：${short(kind)}`, reason, 'unknown');
    item.availability = 'unavailable';
    cover(entry, kind, 'unsupported', reason, item);
    return item;
  };
  const excludeContents = (entry: RecordEntry, value: unknown, reason: string): void => {
    if (Array.isArray(value)) value.forEach((b, index) => cover(entry, str(obj(b).type) || 'content-block', 'excluded', reason, undefined, index));
  };
  const blocks = (entry: RecordEntry, value: unknown, item: TimelineItem, label: string, cuaOutput = false): EvidenceBlock[] => {
    if (typeof value === 'string') return value ? [textBlock(label, value)] : [];
    if (!Array.isArray(value)) {
      const o = obj(value);
      if (Array.isArray(o.content)) return blocks(entry, o.content, item, label, cuaOutput);
      // Known transport result schemas only; arbitrary objects are never dumped.
      if (typeof o.output === 'string') return [textBlock(label, o.output)];
      if (typeof o.task_name === 'string') return [textBlock('子任务标识', o.task_name)];
      if (Array.isArray(o.agents)) return o.agents.map((a) => {
        const agent = obj(a);
        return textBlock('子 Agent 状态', [str(agent.task_name) || str(agent.agent_path) || str(agent.id), str(agent.status)].filter(Boolean).join(' · '));
      }).filter(b => b.text);
      if (value !== undefined && value !== null) {
        cover(entry, 'structured-output', 'unsupported', '结构化结果不在已识别的可显示字段范围内。', item);
        item.availability = 'partial';
      }
      return [];
    }
    const result: EvidenceBlock[] = [];
    value.forEach((value, index) => {
      const b = obj(value); const type = str(b.type) || 'unknown-block';
      if (hiddenBlock(type)) {
        cover(entry, type, 'excluded', '隐藏推理或加密内容不进入观察器。', item, index);
        if (type === 'encrypted_content') item.availability = 'partial';
      } else if (['input_text', 'output_text', 'text', 'Text'].includes(type) && typeof b.text === 'string') {
        if (cuaOutput && cuaRuntimeDocument(b.text)) {
          cover(entry, 'cua:runtime-instructions', 'excluded', '已识别的独立 CUA 运行时指导文档，不是用户请求或工具执行证据；实际结果块另行保留。', item, index);
          return;
        }
        result.push(textBlock(label, b.text));
        cover(entry, type, 'displayed', '显示来源中可取得的文本。', item, index);
        if (b.annotations && (Array.isArray(b.annotations) ? b.annotations.length : true)) {
          cover(entry, `${type}:annotations`, 'unsupported', '附加引用结构尚未解释；正文标记保留。', item, index);
          item.availability = 'partial';
        }
      } else if (['input_image', 'image'].includes(type)) {
        const uri = str(b.image_url) || str(obj(b.image_url).url);
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(uri);
        const mime = str(b.mimeType);
        const encoded = str(b.data);
        const base64 = (match?.[2] ?? encoded).replace(/\s/g, '');
        const declaredMime = match?.[1] ?? mime;
        const valid = /^image\/(?:png|jpeg|gif|webp)$/.test(declaredMime) && base64.length <= 16 * 1024 * 1024 && base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
        const actualMime = valid ? rasterMime(Buffer.from(base64, 'base64')) : undefined;
        if (actualMime) {
          result.push({ kind: 'image', label: actualMime === declaredMime ? '记录中的图像' : `记录中的图像（来源声明 ${declaredMime}，字节签名为 ${actualMime}）`, mime: actualMime, data: base64 });
          cover(entry, type, 'displayed', '保留来源内嵌的图像字节；不读取路径或远程图像。', item, index);
          if (actualMime !== declaredMime) cover(entry, `${type}:mime-mismatch`, 'displayed', `来源声明 ${declaredMime}，使用字节签名 ${actualMime}；字节未改写。`, item, index);
        } else {
          cover(entry, type, 'unsupported', '图像只有引用或格式不受支持；未取得可显示内容。', item, index);
          item.availability = 'partial';
        }
      } else {
        cover(entry, type, 'unsupported', '未识别的内容块，仅保留类型和来源。', item, index);
        item.availability = 'partial';
      }
    });
    return result;
  };
  const addSource = (item: TimelineItem, entry: RecordEntry): void => {
    if (!item.sources.some(s => s.line === entry.line)) item.sources.push(source(entry));
  };
  const readOutput = (entry: RecordEntry, value: unknown, item: TimelineItem, label: string, cuaOutput = false): EvidenceBlock[] => {
    const before = data.coverage.length;
    const output = blocks(entry, value, item, label, cuaOutput);
    const envelope = obj(value);
    const consumed = Array.isArray(envelope.content) ? 'content' : typeof envelope.output === 'string' ? 'output' : typeof envelope.task_name === 'string' ? 'task_name' : Array.isArray(envelope.agents) ? 'agents' : undefined;
    // These are transport/status metadata, not additional returned payloads.
    // A recognized content field does not authorize silently dropping siblings.
    const metadata = new Set(['isError', 'exit_code', 'success', 'status', 'session_id', 'chunk_id', 'wall_time_seconds', 'original_token_count', '_meta']);
    if (consumed && Object.keys(envelope).some(key => key !== consumed && !metadata.has(key))) {
      cover(entry, 'structured-output:additional-fields', 'unsupported', '结果还有未解释的载荷字段；只保留来源，不展示原始对象，也不视作空返回。', item);
      item.availability = 'partial';
    }
    // Only the known orchestration transport can wrap output in status headers.
    // A command's structured stdout or an unrelated tool may quote those lines.
    const transport = typeof value === 'string' || Array.isArray(value) ? transportFor(item) : undefined;
    const readable = output.some(b => b.kind === 'image' ? !!b.data : !!(transport ? returnedText(b.text ?? '', transport) : b.text)?.trim());
    const unreadable = data.coverage.slice(before).some(c => c.disposition === 'unsupported' || (c.disposition === 'excluded' && hiddenBlock(c.kind))) || (!readable && !emptyReturn(value, transport));
    observeResult(item, unreadable ? readable ? 'partial' : 'unreadable' : readable ? 'readable' : 'empty');
    return output;
  };
  const setResult = (item: TimelineItem, value: unknown): void => {
    const parts = typeof value === 'string' ? [value] : Array.isArray(value) ? value.map(b => str(obj(b).text)) : [];
    const transport = transportFor(item);
    const objects = [obj(value), ...(transport ? parts.map(parseObject) : [])];
    // A returned stdout string may quote arbitrary status text. Only a transport
    // prefix, before its Output/Final output delimiter, is status evidence.
    const transportHeader = (text: string): string => {
      const lines = text.split(/\r?\n/); const header: string[] = [];
      for (const line of lines) {
        if (/^(?:Output:|Final output:)\s*$/.test(line)) break;
        if (transport && transportLine(line, transport)) header.push(line);
        else if (line.trim()) break;
      }
      return header.join('\n');
    };
    const headers = transport ? parts.map(transportHeader).filter(Boolean) : [];
    const running = /^Script running with cell ID (\S+)/m.exec(headers.join('\n'));
    if (running) { cells.set(running[1], item); item.status = item.status === 'failed' ? 'failed' : 'running'; item.availability = 'partial'; }
    const outputTexts = [...parts, ...objects.map(o => str(o.output))];
    if (headers.some(h => /^Warning: truncated output/im.test(h)) || outputTexts.some(t => /^(?:Warning: truncated output|\[output truncated\])/i.test(t))) {
      observeResult(item, 'partial');
      append(item, [], '来源输出已截断；详情仅包含记录中实际取得的片段。');
      item.availability = item.detail ? 'partial' : 'unavailable';
    }
    for (const o of objects) {
      const exit = o.exit_code;
      if (typeof exit === 'number') item.exitCode = exit;
      const failed = o.isError === true || o.success === false || o.status === 'failed' || (typeof exit === 'number' && exit !== 0);
      if (failed) item.status = 'failed';
      else if (item.status !== 'failed' && !running && (exit === 0 || o.success === true || o.isError === false)) item.status = 'completed';
      else if (item.status !== 'failed' && (o.session_id !== undefined && exit === undefined)) { item.status = 'running'; item.availability = 'partial'; }
    }
    for (const header of headers) {
      const exit = /^Process exited with code (-?\d+)\s*$/m.exec(header);
      if (exit) item.exitCode = Number(exit[1]);
      if (exit && Number(exit[1]) !== 0) item.status = 'failed';
      else if (exit && item.status !== 'failed' && !running) item.status = 'completed';
    }
    if (item.status !== 'failed' && !running && headers.some(h => /^Script completed\b/.test(h))) {
      // This marks only the orchestration cell, never all commands nested inside it.
      item.status = 'completed';
      append(item, [], '编排调用已结束；该状态不证明内部每个命令或子任务都成功。');
    }
    if (headers.some(h => /^Script (?:failed|terminated)\b/.test(h))) item.status = 'failed';
    if (item.status === 'completed' && item.availability === 'partial' && !item.detail?.notice?.includes('截断') && !data.coverage.some(c => c.itemId === item.id && (c.disposition === 'unsupported' || c.kind === 'encrypted_content'))) {
      item.availability = item.detail ? 'available' : 'none';
    }
    item.summary = item.status === 'running' ? '已取得阶段输出，仍在运行。' : item.status === 'failed' ? '来源报告失败；保留本次调用及结果。' : item.status === 'completed' ? '已取得结束状态和可核对的输出。' : '已取得返回内容；最终成功状态未确认。';
  };

  /** `<send_user_message_question_reply>[{answer, question, questionItemId}]</…>`: the answers, recorded on the question they answer. */
  const questionReply = (entry: RecordEntry, raw: string): boolean => {
    const body = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(raw)?.[1];
    if (body === undefined) return false;
    let replies: unknown;
    try { replies = JSON.parse(body); } catch { return false; }
    if (!Array.isArray(replies)) return false;
    const byCall = new Map<TimelineItem, Array<{ question: string; answer: string }>>();
    for (const reply of replies.map(obj)) {
      let callId = '';
      try { const id = JSON.parse(str(reply.questionItemId)); if (Array.isArray(id)) callId = str(id[1]); } catch { /* not a call reference */ }
      const item = calls.get(callId);
      if (item?.kind !== 'question') return false;
      byCall.set(item, [...(byCall.get(item) ?? []), { question: str(reply.question), answer: str(reply.answer) }]);
    }
    if (!byCall.size) return false;
    for (const [item, answers] of byCall) {
      addSource(item, entry);
      const recorded = JSON.stringify({ questions: answers.map(({ question }) => ({ question })), answers: Object.fromEntries(answers.map(({ question, answer }) => [question, answer])) }, null, 2);
      // The reply is written twice, as a response and as an event.
      if (!item.detail?.blocks.some(block => block.text === recorded)) append(item, [textBlock('问题及记录的回答', recorded, 'json')]);
      cover(entry, 'user:question-reply', 'merged', '异步提问的回复，记在对应的提问调用上，不计为新的用户请求。', item);
    }
    return true;
  };
  const message = (entry: RecordEntry, p: Obj, channel: string): void => {
    const role = str(p.role); const phase = str(p.phase);
    if (role === 'system' || role === 'developer' || phase === 'analysis' || p.channel === 'analysis') {
      // Observed user mirrors may have exactly one excluded instruction envelope
      // between response and event. It is not a user message and its body is never
      // copied, but only a known matching turn permits this narrow adjacency gap.
      if (channel === 'response' && (role === 'system' || role === 'developer') && turn && mirror?.role === 'user' && mirror.turn === turn && mirror.line === entry.line - 1 && mirror.spacerLine === undefined) mirror.spacerLine = entry.line;
      cover(entry, `${role}:${phase || 'message'}`, 'excluded', '系统、开发者指令及隐藏推理不属于公开过程。');
      excludeContents(entry, p.content, '系统、开发者指令及隐藏推理不进入观察器。'); return;
    }
    if (role !== 'assistant' && role !== 'user') { unsupported(entry, `${role || 'unknown'}:message`, '未识别的消息角色。'); excludeContents(entry, p.content, '未识别角色的内容不作通用展示。'); return; }
    const originalContent = Array.isArray(p.content) ? p.content : [{ type: 'text', text: str(p.message) }];
    const content = originalContent.filter((b, index) => {
      if (role === 'user' && imageWrapper(str(obj(b).text))) { cover(entry, 'user:image-wrapper', 'excluded', '图片前后的标签只给图片命名；图片本身照常显示。', undefined, index); return false; }
      if (role !== 'user' || !injection(str(obj(b).text))) return true;
      cover(entry, str(obj(b).type) || 'user:injected-context', 'excluded', '自动附带技能或环境块，不计为新的用户请求。', undefined, index);
      return false;
    });
    const visible = content.filter(b => ['input_text', 'output_text', 'text', 'Text'].includes(str(obj(b).type)));
    const raw = visible.map(b => str(obj(b).text)).join('\n');
    if (role === 'user' && visible.length === content.length && interruptionPlaceholder(raw)) {
      cover(entry, 'user:interruption-placeholder', 'excluded', '系统生成的中断占位文字不计作用户请求；明确的中断事件仍保留。');
      excludeContents(entry, content, '中断占位文字不重复展示。'); return;
    }
    if (!content.length) { cover(entry, 'user:injected-context', 'excluded', '自动附带技能或环境上下文，不计为新的用户请求。'); return; }
    // An async question is also sent as a message; it reads once, as the call that asked it.
    const asked = role === 'assistant' && Array.isArray(p.questions) ? calls.get(str(p.id)) : undefined;
    if (asked?.kind === 'question') { addSource(asked, entry); cover(entry, 'assistant:async-question', 'merged', '异步提问的展示消息，与同 ID 的提问调用合并。', asked); return; }
    // The answer to an async question comes back as a user message; it belongs to that question.
    if (role === 'user' && questionReply(entry, raw)) return;
    // A command run with `!` reads as it was typed. Its run is its own row; only when no row has it is the output kept, in the details.
    const shell = role === 'user' ? userShellCommand(raw) : undefined;
    const shellRan = shell && data.items.some(item => item.turnId === turn && item.kind === 'tool' && item.detail?.blocks.some(block => block.label === '当时命令' && block.text?.trim() === shell.command));
    let request = shell ? `! ${shell.command}` : role === 'user' ? unmatchedReply(raw) ?? raw : raw; let context = '';
    if (role === 'user' && CONTEXT_HEAD.test(raw)) {
      const split = /^## My request:\s*$/m.exec(raw);
      if (split) { context = raw.slice(0, split.index).trim(); request = raw.slice(split.index + split[0].length).replace(BROWSER_STATE, '').trim(); }
      else { cover(entry, 'user:ide-context', 'excluded', '只有 IDE 上下文，没有实际用户请求。'); excludeContents(entry, content, '仅 IDE 上下文。'); return; }
    }
    const citation = Boolean(p.memory_citation) || /<oai-mem-citation>/.test(raw);
    const canMerge = mirror && (mirror.line === entry.line - 1 || mirror.spacerLine === entry.line - 1) && mirror.role === role && mirror.phase === phase && mirror.channel !== channel && mirror.turn === turn && (mirror.text === raw || ((citation || mirror.citation) && citeBody(mirror.text) === citeBody(raw)));
    if (canMerge && mirror) {
      const item = mirror.item; addSource(item, entry);
      cover(entry, `${role}:mirror`, 'merged', mirror.spacerLine === entry.line - 1 ? 'event/response 仅间隔一条已排除的系统／开发者消息；同回合、角色及正文明确对应。' : '相邻 event/response 与同回合、角色和正文明确对应。', item);
      const before = data.coverage.length;
      const incoming = blocks(entry, content, item, '正文');
      for (const c of data.coverage.slice(before)) {
        if (c.source.block !== undefined) c.source.block = originalContent.indexOf(content[c.source.block - 1]) + 1;
        if (c.disposition === 'displayed' && ['input_text', 'output_text', 'text', 'Text'].includes(c.kind)) c.disposition = 'merged';
      }
      const extras = incoming.filter(b => b.kind !== 'text' && !item.detail?.blocks.some(old => old.kind === b.kind && old.data === b.data && old.mime === b.mime));
      append(item, extras);
      if (raw !== mirror.text && raw.includes('<oai-mem-citation>')) {
        if (item.detail) item.detail.blocks = item.detail.blocks.filter(b => b.label !== '正文');
        append(item, [textBlock('正文', request)]);
      }
      mirror = undefined; return;
    }
    const kind: ItemKind = role === 'user' ? 'request' : phase === 'final_answer' || phase === 'final' ? 'answer' : 'message';
    const item = add(entry, kind, kind === 'request' ? '用户请求' : kind === 'answer' ? '历史回答' : '过程说明', short(request));
    const coverageBefore = data.coverage.length;
    const detailBlocks = blocks(entry, content, item, '正文');
    for (const c of data.coverage.slice(coverageBefore)) if (c.source.block !== undefined) c.source.block = originalContent.indexOf(content[c.source.block - 1]) + 1;
    if (shell) {
      detailBlocks.splice(0, detailBlocks.length, textBlock('用户请求', request), ...(shellRan || !shell.result.trim() ? [] : [textBlock('命令输出', shell.result, 'code')]));
      cover(entry, 'user:shell-command', 'displayed', shellRan ? '用户用 ! 运行的命令；执行和输出见同回合的命令记录。' : '用户用 ! 运行的命令；来源没有单独的执行记录，输出保留在详情中。', item);
    }
    if (context) {
      const media = detailBlocks.filter(b => b.kind !== 'text');
      detailBlocks.splice(0, detailBlocks.length, textBlock('用户请求', request), textBlock('随请求附带的 IDE 背景', context), ...media);
      cover(entry, 'user:ide-background', 'displayed', '与本次请求关联的背景，不另计用户提问。', item);
    }
    if (p.memory_citation && typeof p.memory_citation === 'object') {
      const citationEntries = obj(p.memory_citation).entries;
      if (Array.isArray(citationEntries)) detailBlocks.push(textBlock('记录中的记忆引用', citationEntries.map(e => { const c = obj(e); return `${str(c.path)}:${Number(c.lineStart) || '?'}-${Number(c.lineEnd) || '?'} ${str(c.note)}`; }).join('\n')));
    }
    if (kind === 'answer' || context || (shell && !shellRan) || request !== item.summary || detailBlocks.some(b => b.kind !== 'text') || p.memory_citation) append(item, detailBlocks);
    else if (item.availability === 'partial') append(item, detailBlocks, '部分内容块不可显示；已保留可取得的公开文本。');
    if (item.availability === 'partial' && !item.detail) item.availability = 'unavailable';
    cover(entry, `${role}:${phase || 'message'}`, kind === 'answer' ? 'original-chat' : 'displayed', kind === 'answer' ? '完整回答以原聊天为主，此处保留历史详情入口。' : '显示公开消息；短正文已完整显示时不重复提供详情。', item);
    if (kind === 'request' && data.title === 'Codex session' && request.trim()) data.title = short(request.trim());
    mirror = { line: entry.line, role, phase, channel, text: raw, turn, item, citation };
  };

  const patch = (entry: RecordEntry, p: Obj): void => {
    const changes = Object.entries(obj(p.changes));
    // A native FileChange can mirror an apply_patch input. Match exact changed
    // content in a single pending call; paths or adjacency alone are insufficient.
    const matching = [...new Set(calls.values())].flatMap(candidate => {
      if (candidate.turnId !== turn || candidate.result !== 'not-observed') return [];
      return recordedToolInputs(candidate).map((input, callIndex) => ({ candidate, input, callIndex }));
    }).filter(({ candidate, input, callIndex }) => {
      if (input.name !== 'apply_patch' || matchedPatchInputs.has(`${candidate.id}:${callIndex}`)) return false;
      const files = parsePatch(typeof input.input === 'string' ? input.input : str(obj(input.input).patch));
      if (!files || !changes.length || files.length !== changes.length) return false;
      return files.every(file => {
        const change = obj(obj(p.changes)[file.path]);
        if (change.type !== file.operation || file.moveTo !== (str(change.move_path) || undefined)) return false;
        if (file.operation === 'add') return file.lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n').replace(/\n$/, '') === str(change.content).replace(/\n$/, '');
        if (file.operation === 'update' && typeof change.unified_diff === 'string') {
          const edits = (lines: string[]) => lines.filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
          const expected = edits(file.lines), actual = edits(change.unified_diff.split('\n'));
          // Native diff may move an identical blank line across context. Keep
          // nonblank edits ordered and require the same signed blank counts.
          const normalized = (lines: string[]) => [lines.filter(line => line.slice(1).trim()), lines.filter(line => line === '+').length, lines.filter(line => line === '-').length];
          return expected.some(line => line.slice(1).trim()) && JSON.stringify(normalized(expected)) === JSON.stringify(normalized(actual));
        }
        return false;
      });
    });
    const match = matching.length === 1 ? matching[0] : undefined;
    if (match) matchedPatchInputs.add(`${match.candidate.id}:${match.callIndex}`);
    const matched = match && recordedToolInputs(match.candidate).length === 1 ? match.candidate : undefined;
    const item = matched ?? add(entry, 'file-change', '记录中的文件修改', changes.map(([path]) => path).join(', ') || '修改事件没有可取得的文件内容。');
    if (match && !matched) item.patchInput = { itemId: match.candidate.id, callIndex: match.callIndex };
    item.status = p.success === false || p.status === 'failed' ? 'failed' : p.success === true || p.status === 'completed' ? 'completed' : 'unknown';
    if (matched) { addSource(item, entry); item.kind = 'file-change'; }
    const before = data.coverage.length;
    const evidence: EvidenceBlock[] = [];
    for (const [path, value] of changes) {
      const change = obj(value); const type = str(change.type);
      if (type === 'update' && typeof change.unified_diff === 'string') evidence.push(textBlock(path, change.unified_diff, 'patch'));
      else if ((type === 'add' || type === 'delete') && typeof change.content === 'string') evidence.push(textBlock(`${path} · ${type === 'add' ? '当时新增内容' : '当时删除内容'}`, change.content, 'code'));
      else { cover(entry, `file-change:${type || 'unknown'}`, 'unsupported', '已知文件变化，但未取得可显示的当时 patch 或内容。', item); item.availability = 'partial'; }
      if (str(change.move_path)) evidence.push(textBlock('记录中的目标路径', str(change.move_path)));
    }
    if (str(p.stderr)) evidence.push(textBlock('修改返回错误', str(p.stderr)));
    append(item, evidence);
    const readable = evidence.some(b => !!b.text?.trim());
    const knownChanges = p.changes !== null && typeof p.changes === 'object' && !Array.isArray(p.changes);
    const unreadable = data.coverage.slice(before).some(c => c.disposition === 'unsupported') || (p.changes !== undefined && !knownChanges) || (p.stderr !== undefined && typeof p.stderr !== 'string') || (!knownChanges && typeof p.stderr !== 'string');
    observeResult(item, unreadable ? readable ? 'partial' : 'unreadable' : readable ? 'readable' : 'empty');
    if (item.detail) item.detail.provenance = '来源记录中的 patch／当时文件内容；不是当前 Git diff，也不是回合最终聚合 diff。';
    if (!evidence.length) item.availability = 'unavailable';
    cover(entry, 'file-change', matched ? 'merged' : 'displayed', matched ? '完整修改内容与唯一待返回 apply_patch 相符；合并显示，保留两个来源。' : '按修改事件本身的可信状态展示。', item);
  };
  const subagent = (entry: RecordEntry, p: Obj, isMessage = false): void => {
    const name = str(p.agent_path) || str(p.author) || str(p.agent_thread_id) || '子 Agent';
    const state = str(p.kind); const status: ItemStatus = state === 'completed' ? 'completed' : state === 'started' || state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'info';
    const item = add(entry, 'subagent', name, isMessage ? '来自子 Agent 的记录；只读查看。' : `已记录活动：${state || '未知'}。`, status);
    item.result = 'not-observed';
    if (isMessage) {
      const body = readOutput(entry, p.content ?? p.message, item, '子 Agent 返回');
      append(item, body, '仅主会话中可取得的返回；不代表子 Agent 内部过程完整。');
      const hasPayload = body.some(b => b.kind === 'image' ? !!b.data : b.text && !/^Message Type:[\s\S]*Payload:\s*$/.test(b.text));
      if (!hasPayload) {
        // Transport headers without a visible payload add no evidence beyond the node.
        item.detail = undefined;
        item.availability = 'unavailable';
        item.result = emptyReturn(p.content ?? p.message) ? 'empty' : 'unreadable';
      } else item.availability = 'partial';
    }
    cover(entry, isMessage ? 'subagent:message' : 'subagent:activity', 'displayed', '保留子 Agent 身份和主会话已取得的活动边界。', item);
  };

  let line = 0;
  for (;;) {
    const raw = yield data;
    if (raw === null) break;
    line++;
    if (typeof raw === 'string' && !raw.trim()) continue;
    let entry: RecordEntry;
    try {
      const record = obj(typeof raw === 'string' ? JSON.parse(raw) : raw.record);
      if (!Object.keys(record).length) throw new Error('not an object');
      entry = { line, record, payload: obj(record.payload) };
    } catch {
      data.coverage.push({ source: { file: input.file, line }, kind: 'invalid-jsonl', disposition: 'unsupported', reason: '记录未完整写入或无法解码；未展示原始片段。' });
      data.warnings.push(`第 ${line} 行无法解码；其后完整记录仍会处理。`);
      continue;
    }
    const { record, payload: p } = entry;
    const explicitTurn = str(p.turn_id) || str(obj(p.internal_chat_message_metadata_passthrough).turn_id);
    const top = str(record.type); const type = str(p.type);
    // A record's explicit turn is local evidence, not permission for a delayed
    // event from an older turn to retarget subsequent unmarked records.
    if (top === 'event_msg' && type === 'task_started') activeTurn = explicitTurn || undefined;
    else if (explicitTurn && top === 'turn_context') activeTurn = explicitTurn;
    turn = explicitTurn || activeTurn;
    if (top === 'session_meta') {
      const inherited = str(p.id) && str(p.id) !== data.id;
      cover(entry, top, 'excluded', inherited ? '继承历史中的其他会话元数据不改变此日志首条会话身份；运行配置和指令不进入观察器。' : '只取会话身份；运行配置和指令不进入观察器。');
      if (inherited) data.warnings.push(`第 ${entry.line} 行含继承历史的其他会话元数据；保留此日志首条会话身份，继承记录不代表在本会话再次执行。`);
      continue;
    }
    if (top === 'turn_context' || top === 'world_state' || top === 'token_usage_record' || top === 'inter_agent_communication_metadata') { cover(entry, top, 'excluded', '运行上下文／用量不作为聊天正文。'); continue; }
    if (top === 'compacted' || (top === 'event_msg' && type === 'context_compacted')) {
      const key = turn ?? String(entry.line); const prior = compactions.get(key);
      const item = prior ?? add(entry, 'notice', '上下文已压缩', '');
      item.noticeType = 'context-compacted';
      if (prior) addSource(item, entry);
      else compactions.set(key, item);
      // Only the explicit compaction message; replacement/guardian history can
      // contain private instructions and is not a public summary reader.
      const summary = top === 'compacted' ? str(p.message).trim() : '';
      if (summary && !item.detail?.blocks.some(block => block.text === summary)) append(item, [textBlock('压缩摘要', summary)]);
      cover(entry, 'context-compaction', prior ? 'merged' : 'displayed', '压缩边界不计成请求；仅非空的显式压缩摘要提供详情。', item);
      continue;
    }
    if (top === 'event_msg' && type === 'agent_reasoning') { cover(entry, 'event:agent_reasoning', 'excluded', '隐藏推理事件不解析、不展示；不推断运行状态。'); continue; }
    if (top === 'response_item' && type === 'reasoning' && Array.isArray(p.summary)) {
      // Codex shows these summary lines in its own UI; the reasoning body stays private.
      const said = p.summary.map(part => obj(part)).filter(part => part.type === 'summary_text' && typeof part.text === 'string')
        .map(part => str(part.text).trim().replace(/^\*\*([^*\n]+)\*\*$/, '$1')).filter(Boolean).join('\n\n');
      if (said) {
        const item = add(entry, 'message', '思考摘要', short(said));
        if (said !== item.summary) append(item, [textBlock('正文', said)]);
        cover(entry, 'reasoning:summary', 'displayed', 'Codex 界面中显示的思考摘要；推理正文与加密内容不读取。', item);
        excludeContents(entry, p.content, '隐藏推理不展示。'); continue;
      }
    }
    if (top === 'response_item' && (type === 'reasoning' || type === 'encrypted_content')) { cover(entry, type, 'excluded', '隐藏推理不解析、不展示。'); excludeContents(entry, p.content, '隐藏推理不展示。'); continue; }
    if (top === 'response_item' && type === 'message') { message(entry, p, 'response'); continue; }
    if (top === 'event_msg' && (type === 'agent_message' || type === 'user_message')) {
      message(entry, { ...p, role: type === 'user_message' ? 'user' : 'assistant' }, 'event');
      for (const field of ['images', 'local_images', 'audio', 'local_audio', 'text_elements']) if (Array.isArray(p[field]) && (p[field] as unknown[]).length) cover(entry, `message:${field}`, 'unsupported', '事件附件元数据不等于已取得附件内容。');
      continue;
    }
    if (top === 'response_item' && (type === 'custom_tool_call' || type === 'function_call')) {
      const call = str(p.call_id); const name = [str(p.namespace), str(p.name)].filter(Boolean).join('/'); const argumentsText = str(p.arguments) || str(p.input); const args = parseObject(p.arguments);
      const waiting = /(?:^|\/)wait$/.test(name) ? cells.get(str(args.cell_id)) : undefined;
      const native = nativeMcpCalls.has(call) ? calls.get(call) : undefined;
      const previous = native && native.turnId === turn && native.title.replace(/\//g, '__') === name.replace(/\//g, '__') ? native : undefined;
      const item = waiting ?? previous ?? add(entry, /request_user_input/.test(name) ? 'question' : /collaboration\//.test(name) ? 'subagent' : 'tool', name || '工具调用', '调用已记录；尚无最终结果。', 'unknown');
      if (!waiting && !previous) item.result = 'not-observed';
      addSource(item, entry);
      if (call) { if (calls.has(call) && !previous && !waiting) data.warnings.push(`第 ${entry.line} 行重用了 call_id；作为新的调用保留。`); calls.set(call, item); cuaCalls.delete(call); }
      if (str(p.namespace) === 'mcp__cua_repl' && ['js', 'js_reset'].includes(str(p.name))) cuaCalls.add(call);
      append(item, argumentsText && !item.detail?.blocks.some(b => b.text === argumentsText) ? [textBlock(waiting ? '后续读取调用' : previous && item.detail?.blocks.some(b => b.label === '记录中的调用参数') ? '同一调用 ID 的另一组记录参数' : '记录中的调用参数', argumentsText, 'code')] : []);
      if (item.kind === 'question') append(item, [], '这是记录中的提问和已知回复；Tickbird 不提供作答或批准入口。');
      cover(entry, type, waiting || previous ? 'merged' : 'displayed', waiting ? '通过明确 cell_id 关联同一次长任务的后续读取。' : '只读展示调用输入；同 ID 的原生 MCP 记录合并保留。', item);
      continue;
    }
    if (top === 'response_item' && (type === 'custom_tool_call_output' || type === 'function_call_output')) {
      const call = str(p.call_id); const item = calls.get(call) ?? add(entry, 'tool', '未配对工具结果', '没有找到对应调用，保留结果来源。', 'unknown');
      addSource(item, entry);
      if (!calls.has(call)) data.warnings.push(`第 ${entry.line} 行工具结果没有对应 call_id。`);
      // A direct file reader returns document text, even when that document is
      // JSON. Other existing structured result readers keep their narrow schema.
      const readDocument = /^(?:functions[/.])?(?:Read|read|read_file)$/.test(item.title);
      const output = !readDocument && typeof p.output === 'string' && Object.keys(parseObject(p.output)).length ? parseObject(p.output) : p.output;
      const before = data.coverage.length;
      const outputBlocks = readOutput(entry, output, item, '当时返回的内容', cuaCalls.has(call));
      const unique = mcpResults.has(call) ? outputBlocks.filter(b => !item.detail?.blocks.some(existing => existing.kind === b.kind && existing.text === b.text && existing.data === b.data && existing.mime === b.mime)) : outputBlocks;
      if (mcpResults.has(call) && !unique.length) for (const c of data.coverage.slice(before)) if (c.disposition === 'displayed') c.disposition = 'merged';
      append(item, unique);
      setResult(item, p.output); cover(entry, type, 'merged', '按明确 call_id 关联输出；同次 MCP 返回的相同内容块合并，阶段输出不推断最终成功。', item);
      if (item.availability === 'partial' && !item.detail) item.availability = 'unavailable';
      continue;
    }
    if (top === 'response_item' && type === 'agent_message') { subagent(entry, p, true); continue; }
    if (top !== 'event_msg') { unsupported(entry, `${top || 'unknown'}${type ? `:${type}` : ''}`, '未识别的记录类型；未输出其原始正文。'); continue; }
    if (['token_count', 'thread_settings_applied', 'thread_name_updated'].includes(type)) { cover(entry, type, 'excluded', '运行元数据不进入过程栏。'); continue; }
    if (type === 'task_started' || type === 'task_complete' || type === 'task_aborted' || type === 'turn_aborted') {
      const aborted = type === 'task_aborted' || type === 'turn_aborted';
      const item = add(entry, 'notice', type === 'task_started' ? '回合开始' : type === 'task_complete' ? '回合结束' : '回合中断', type === 'task_complete' ? '来源记录了回合结束；不代表每个工具或子任务成功。' : aborted ? '来源记录了本回合中断；不代表已启动的命令或子任务全部停止。' : '来源记录了新的回合。', type === 'task_started' ? 'running' : type === 'task_complete' ? 'completed' : 'unknown');
      cover(entry, type, 'displayed', '只取明确回合状态；不以宿主耗时口径推算显示耗时。', item);
      if (type === 'task_complete' && p.last_agent_message) cover(entry, 'task_complete:last_agent_message', 'merged', '回合结束的回答副本不重复计为新消息。', item);
      // Interruption closes only the matching turn association. Calls and child
      // processes keep their independently observed states and can return later.
      if (type !== 'task_started' && (!explicitTurn || explicitTurn === activeTurn)) activeTurn = undefined;
      continue;
    }
    if (type === 'patch_apply_end') { patch(entry, p); continue; }
    if (type === 'sub_agent_activity') { subagent(entry, p); continue; }
    if (type === 'mcp_tool_call_end') {
      const call = str(p.call_id); const invocation = obj(p.invocation); const result = obj(p.result); const ok = obj(result.Ok); const item = calls.get(call) ?? add(entry, 'tool', [str(invocation.server), str(invocation.tool)].filter(Boolean).join('/') || 'MCP 工具', '记录中的工具结果。', 'unknown');
      addSource(item, entry); calls.set(call, item);
      if (str(invocation.server) === 'cua_repl' && ['js', 'js_reset'].includes(str(invocation.tool))) cuaCalls.add(call);
      if (result.Err !== undefined) {
        item.status = 'failed';
        append(item, typeof result.Err === 'string' ? [textBlock('MCP 返回错误', result.Err)] : []);
        observeResult(item, typeof result.Err === 'string' ? result.Err.trim() ? 'readable' : 'empty' : 'unreadable');
      }
      else { append(item, readOutput(entry, ok, item, 'MCP 当时返回的内容', cuaCalls.has(call))); setResult(item, ok); }
      mcpResults.add(call); cover(entry, type, 'merged', '按 call_id 保存可显示返回及协议错误状态。', item); continue;
    }
    if (type === 'web_search_end') {
      const item = add(entry, 'tool', 'Web 来源', short(str(p.query)), 'info');
      const found = Array.isArray(p.results) ? p.results : [];
      append(item, found.flatMap(value => { const r = obj(value); return r.type === 'text_result' ? [textBlock(str(r.title) || '来源', [str(r.url), str(r.snippet)].filter(Boolean).join('\n'))] : []; }));
      found.forEach((r, index) => cover(entry, `web:${str(obj(r).type) || 'unknown'}`, obj(r).type === 'text_result' ? 'displayed' : 'unsupported', '仅展示可核对的来源标题、链接和片段；不主动访问。', item, index));
      const readable = found.some(r => obj(r).type === 'text_result' && [obj(r).title, obj(r).url, obj(r).snippet].some(v => !!str(v).trim()));
      const unreadable = !Array.isArray(p.results) || found.some(r => obj(r).type !== 'text_result');
      observeResult(item, unreadable ? readable ? 'partial' : 'unreadable' : readable ? 'readable' : 'empty');
      cover(entry, type, 'displayed', '保留来源结果，不将返回事件推断为所有研究步骤成功。', item); continue;
    }
    if (type === 'item_completed' || type === 'item_started') {
      const nested = obj(p.item); const nestedType = str(nested.type);
      if (nestedType === 'McpToolCall') {
        const call = str(nested.id) || str(nested.call_id);
        const name = `mcp__${str(nested.server)}__${str(nested.tool)}`;
        const candidate = call ? calls.get(call) : undefined;
        const previous = candidate && candidate.turnId === turn && candidate.title.replace(/\//g, '__') === name ? candidate : undefined;
        const item = previous ?? add(entry, 'tool', name, '记录中的 MCP 调用。', type === 'item_started' ? 'running' : 'unknown');
        addSource(item, entry);
        if (call) { calls.set(call, item); nativeMcpCalls.add(call); }
        if (!previous) item.result = 'not-observed';
        const args = nested.arguments;
        const input = typeof args === 'string' ? args : args !== undefined ? JSON.stringify(args) : '';
        if (input && !item.detail?.blocks.some(block => ['记录中的调用参数', '同一调用 ID 的另一组记录参数'].includes(block.label) && block.text === input)) {
          append(item, [textBlock(item.detail?.blocks.some(block => block.label === '记录中的调用参数') ? '同一调用 ID 的另一组记录参数' : '记录中的调用参数', input, 'code')]);
        }
        const cua = str(nested.server) === 'cua_repl' && ['js', 'js_reset'].includes(str(nested.tool));
        if (cua && call) cuaCalls.add(call);
        if (nested.result !== undefined && nested.result !== null) {
          const output = readOutput(entry, nested.result, item, 'MCP 当时返回的内容', cua);
          append(item, output.filter(block => !item.detail?.blocks.some(old => old.kind === block.kind && old.text === block.text && old.data === block.data && old.mime === block.mime)));
          setResult(item, nested.result);
          if (call) mcpResults.add(call);
        }
        if (nested.status === 'failed' || obj(nested.result).isError === true) item.status = 'failed';
        else if (item.status !== 'failed' && ['completed', 'running'].includes(str(nested.status))) item.status = nested.status as ItemStatus;
        cover(entry, 'item:McpToolCall', previous ? 'merged' : 'displayed', '按调用 ID 关联 MCP 输入与公开返回；不读取隐藏内容或私有元数据。', item);
        continue;
      }
      if (type === 'item_started') { cover(entry, `item-start:${nestedType || 'unknown'}`, 'excluded', '起始元数据；完成记录单独解析。'); continue; }
      if (nestedType === 'Reasoning') { cover(entry, `item:${nestedType}`, 'excluded', '隐藏推理字段不读取、不展示。'); continue; }
      if (nestedType === 'AgentMessage' || nestedType === 'UserMessage') { message(entry, { ...nested, role: nestedType === 'UserMessage' ? 'user' : 'assistant' }, 'event'); continue; }
      if (nestedType === 'SubAgentActivity') { subagent(entry, nested); continue; }
      if (nestedType === 'FileChange') { patch(entry, nested); continue; }
      if (nestedType === 'CommandExecution') {
        const script = shellArgvScript(nested.command);
        const command = script ?? (Array.isArray(nested.command) ? nested.command.map(part => `'${str(part).replace(/'/g, `'\\''`)}'`).join(' ') : str(nested.command));
        const item = add(entry, 'tool', '命令执行记录', short(command), 'unknown');
        let cwd = str(nested.cwd);
        try { if (cwd.startsWith('file:')) cwd = fileURLToPath(cwd); } catch { cwd = ''; }
        const matching = script === undefined || !cwd.startsWith('/') ? [] : [...new Set(calls.values())].flatMap(candidate => {
          if (!turn || candidate.turnId !== turn || candidate.result !== 'not-observed') return [];
          return recordedToolInputs(candidate).flatMap((call, callIndex) => {
            const args = obj(call.input), key = `${candidate.id}:${callIndex}`;
            return call.name === 'exec_command' && !matchedCommandInputs.has(key)
              && (str(args.cmd) || str(args.command)) === script && resolve(input.projectPath, str(args.workdir) || '.') === resolve(cwd)
              ? [{ itemId: candidate.id, callIndex, key }] : [];
          });
        });
        if (matching.length === 1) {
          item.commandInput = { itemId: matching[0].itemId, callIndex: matching[0].callIndex };
          matchedCommandInputs.add(matching[0].key);
        }
        append(item, [textBlock('当时命令', command, 'code'), ...[str(nested.aggregated_output) || str(nested.stdout), str(nested.stderr)].filter(Boolean).map(t => textBlock('当时返回', t))]);
        if (Array.isArray(nested.command)) append(item, [textBlock('原始执行 argv', JSON.stringify(nested.command, null, 2), 'json')]);
        const outputValues = [nested.aggregated_output, nested.stdout, nested.stderr].filter(v => v !== undefined);
        const readable = outputValues.some(v => !!str(v).trim());
        const unreadable = !outputValues.length || outputValues.some(v => typeof v !== 'string');
        observeResult(item, unreadable ? readable ? 'partial' : 'unreadable' : readable ? 'readable' : 'empty');
        if (outputValues.some(v => /^(?:Warning: truncated output|\[output truncated\])/i.test(str(v)))) observeResult(item, 'partial');
        setResult(item, nested); cover(entry, `item:${nestedType}`, 'displayed', '显示当时执行事件与明确退出状态；不执行命令。', item); continue;
      }
      if (nestedType === 'ContextCompaction') { cover(entry, `item:${nestedType}`, 'excluded', '压缩元数据；压缩边界由上下文事件显示。'); continue; }
      if (nestedType === 'Extension' && nested.kind === 'web.search') {
        const item = add(entry, 'tool', 'Web 来源', short(str(nested.query)));
        const results = Array.isArray(nested.results) ? nested.results : [];
        for (const [index, value] of results.entries()) {
          const r = obj(value);
          if (r.type === 'text_result') { append(item, [textBlock(str(r.title) || '来源', [str(r.url), str(r.snippet)].filter(Boolean).join('\n'))]); cover(entry, 'web:text_result', 'displayed', '来源标题、链接及当时片段。', item, index); }
          else { cover(entry, `web:${str(r.type) || 'unknown'}`, 'unsupported', '来源结果类型未识别。', item, index); item.availability = item.detail ? 'partial' : 'unavailable'; }
        }
        const readable = results.some(r => obj(r).type === 'text_result' && [obj(r).title, obj(r).url, obj(r).snippet].some(v => !!str(v).trim()));
        const unreadable = !Array.isArray(nested.results) || results.some(r => obj(r).type !== 'text_result');
        observeResult(item, unreadable ? readable ? 'partial' : 'unreadable' : readable ? 'readable' : 'empty');
        cover(entry, 'item:Extension:web.search', 'displayed', '只读取已记录的来源结果，不访问链接。', item); continue;
      }
      unsupported(entry, `item:${nestedType || 'unknown'}`, nestedType === 'ImageView' ? '只记录了图像路径；尚未取得图像字节。' : '该完成事件的嵌套类型尚未支持，保留类型及来源。'); continue;
    }
    unsupported(entry, `event:${type || 'unknown'}`, '新事件尚未识别；保留来源供覆盖核对。');
  }
  return data;
}
