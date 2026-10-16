import { claudeExitPrefix } from './outcome';
import type { CoverageRecord, EvidenceBlock, ItemKind, ParseInput, SessionData, SourceRef, TimelineItem } from './model';
import { explicitSessionTitle } from './session-title';
import { interruptionPlaceholder, parseSnapshot, sourceTimestamp, type ParserContext, type SessionParser } from './jsonl';
import { editorContext, openedFileOnly, plainPasted } from './pasted';

type Obj = Record<string, any>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const short = (value: string): string => value.length > 180 ? value.slice(0, 180) + '…' : value;
const textBlock = (label: string, text: string, kind: EvidenceBlock['kind'] = 'text'): EvidenceBlock => ({ kind, label, text });
type ObservedResult = Exclude<TimelineItem['result'], undefined | 'not-observed'>;
const observeResult = (item: TimelineItem, result: ObservedResult): void => {
  const previous = item.result;
  if (!previous || previous === 'not-observed' || previous === 'empty') item.result = result;
  else if (result !== 'empty' && result !== previous) item.result = 'partial';
};
const emptyReturn = (value: unknown): boolean => typeof value === 'string' ? !value.trim() : Array.isArray(value) && value.every(value => {
  const block = object(value);
  return block.type === 'text' && typeof block.text === 'string' && !block.text.trim();
});
const hidden = new Set(['thinking', 'redacted_thinking', 'reasoning', 'encrypted_content']);
const metadata = new Set(['mode', 'permission-mode', 'atis-latch', 'bridge-session', 'ai-title', 'last-prompt', 'queue-operation', 'cost-state', 'frame-link', 'artifact-comment-monitor', 'artifact-autoreact-ledger']);
const knownTools = new Set(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'ToolSearch', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'Skill', 'Agent', 'Task', 'Artifact', 'SendMessage', 'Workflow']);
// These are the two MCP input shapes observed in the fixed CL1 sample. A
// recognized tool name never authorizes dumping additional raw input fields.
const sampledMcpInput = (name: string, input: Obj): { value?: Obj; extraFields: boolean } | undefined => {
  if (name === 'mcp__claude-in-chrome__tabs_context_mcp') {
    return { value: typeof input.createIfEmpty === 'boolean' ? { createIfEmpty: input.createIfEmpty } : undefined, extraFields: Object.keys(input).some(key => key !== 'createIfEmpty') };
  }
  if (name === 'mcp__claude-in-chrome__computer') {
    const region = input.region;
    const valid = input.action === 'zoom' && Number.isInteger(input.tabId) && input.tabId >= 0 && Array.isArray(region) && region.length === 4 && region.every(value => typeof value === 'number' && Number.isFinite(value));
    return { value: valid ? { action: input.action, tabId: input.tabId, region: [...region] } : undefined, extraFields: Object.keys(input).some(key => !['action', 'tabId', 'region'].includes(key)) };
  }
  return undefined;
};
const injectedAttachments = new Set(['total_tokens_reminder', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'auto_mode', 'date_change', 'command_permissions',
  // Runtime context Claude Code attaches for the model, never something the user sent.
  'environment', 'date', 'model', 'instructions', 'session_context', 'prompt_snapshot', 'deferred_tools_record',
  'remote_session_change', 'silent_turn_reminder', 'task_reminder', 'compact_file_reference']);
const injected = (value: string): boolean => /^\s*(?:<(?:system-reminder|system_reminder|local-command-caveat|command-name|local-command-stdout|environment_context|skills_instructions|skill|user_instructions)\b|# AGENTS\.md instructions for\b)/.test(value);
/**
 * A command the agent carries out, a skill or a plugin's prompt command, is
 * recorded as its tags, `<command-message>` first: the request is the command
 * as it was typed, with its arguments. Commands Claude Code runs itself
 * (/clear, /model) start with `<command-name>` and are not requests (injected).
 */
const typedCommand = (value: string): string | undefined => {
  if (!/^\s*<command-message>/.test(value)) return undefined;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(value)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(value)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
};
const asyncLaunchWrapper = (text: string, result: Obj): boolean => {
  if (result.isAsync !== true || result.status !== 'async_launched' || typeof result.agentId !== 'string' || typeof result.outputFile !== 'string') return false;
  // Match the complete observed transport template, including identities from
  // the independently recorded async result. Incidental words such as internal
  // or a quotation of part of these instructions are not a filter condition.
  const expected = [
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
    `agentId: ${result.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${result.agentId}', summary: '<5-10 word recap>' to continue this agent.)`,
    'The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.',
    "Do not duplicate this agent's work — avoid working with the same files or topics it is using.",
    `output_file: ${result.outputFile}`,
    "Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
  ].join('\n');
  return text.replace(/\r\n/g, '\n').trimEnd() === expected;
};

/** A supplied snapshot is data only: no execution, source-file reads, or URL resolution. */
/**
 * `toolUseResult.structuredPatch` of an Edit or a Write: unified hunks, each
 * with its first line numbers and its lines already marked ' ', '-' or '+'.
 */
function recordedPatch(structured: Record<string, unknown>): { path: string; text: string } | undefined {
  const hunks = structured.structuredPatch;
  if (typeof structured.filePath !== 'string' || !Array.isArray(hunks) || !hunks.length) return undefined;
  const parts: string[] = [];
  for (const value of hunks) {
    const hunk = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const { oldStart, oldLines, newStart, newLines, lines } = hunk;
    if (![oldStart, oldLines, newStart, newLines].every(n => Number.isInteger(n)) || !Array.isArray(lines) || !lines.every(line => typeof line === 'string' && /^[ +\-\\]/.test(line))) return undefined;
    parts.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...(lines as string[]).filter(line => !line.startsWith('\\')));
  }
  return { path: structured.filePath, text: parts.join('\n') };
}

export function parseClaude(input: ParseInput): SessionData {
  return parseSnapshot(input, 'claude', createClaudeParser);
}

export function* createClaudeParser(input: ParserContext): SessionParser {
  const data: SessionData = { id: input.sessionId, provider: 'claude', projectPath: input.projectPath,
    title: 'Claude Code session', items: [], coverage: [], warnings: [] };
  let timestamp: string | undefined;
  const calls = new Map<string, TimelineItem>();
  const callInputs = new Map<string, string>();
  const agents = new Map<string, TimelineItem>();
  // Calls that left a task running in the background, by the task's id.
  const tasks = new Map<string, TimelineItem>();
  const messages = new Map<string, TimelineItem>();
  const seenBlocks = new Map<string, { item?: TimelineItem; text: string }>();
  const incomplete = new Set<string>();
  // Requests by the record they answer, and turns the source already closed.
  const requestParents = new Map<string, TimelineItem>();
  const closedTurns = new Set<string>();
  let turn: string | undefined;
  const cover = (source: SourceRef, kind: string, disposition: CoverageRecord['disposition'], reason: string, item?: TimelineItem) => {
    data.coverage.push({ source, kind, disposition, reason, ...(item ? { itemId: item.id } : {}) });
  };
  const add = (source: SourceRef, kind: ItemKind, title: string, summary: string): TimelineItem => {
    const item: TimelineItem = { id: `${data.id}:${source.line}:${source.block ?? 0}:${data.items.length}`, sessionId: data.id,
      turnId: turn, kind, title, summary, status: 'info', sources: [source], availability: 'none' };
    if (timestamp) item.timestamp = timestamp;
    data.items.push(item); return item;
  };
  const addSource = (item: TimelineItem, source: SourceRef) => {
    if (!item.sources.some(s => s.line === source.line && s.block === source.block)) item.sources.push(source);
  };
  const append = (item: TimelineItem, blocks: EvidenceBlock[], notice?: string) => {
    const available = blocks.filter(block => block.kind === 'image' ? !!block.data : !!block.text?.trim());
    if (available.length) {
      item.detail ??= { title: item.title, blocks: [], provenance: '来自当时保存的会话记录；未执行调用，也未读取当前文件或引用目标。' };
      item.detail.blocks.push(...available);
      item.availability = incomplete.has(item.id) || item.availability === 'partial' || notice ? 'partial' : 'available';
    }
    if (notice) {
      if (item.detail) { item.detail.notice = [item.detail.notice, notice].filter(Boolean).join('\n'); item.availability = 'partial'; }
      else item.availability = 'unavailable';
    }
  };
  const unavailable = (source: SourceRef, type: string, reason: string, item?: TimelineItem) => {
    const target = item ?? add(source, 'notice', `待核对：${short(type)}`, reason);
    incomplete.add(target.id);
    target.availability = target.detail ? 'partial' : 'unavailable';
    if (target.detail) append(target, [], reason);
    cover(source, type, 'unsupported', reason, target);
  };
  const publicText = (raw: string, source: SourceRef, item?: TimelineItem): string => raw.replace(/(^|\n)[ \t]*<(?:system-reminder|system_reminder)>[\s\S]*?<\/(?:system-reminder|system_reminder)>[ \t]*(?=\r?\n|$)/g, () => {
    cover(source, 'embedded-system-reminder', 'excluded', '自动附带的系统提醒不复制为公开正文。', item); return '';
  });
  const contentBlocks = (value: unknown, source: SourceRef, item: TimelineItem, label: string): EvidenceBlock[] => {
    if (typeof value === 'string') { const text = publicText(value, source, item); return text.trim() ? [textBlock(label, text)] : []; }
    if (!Array.isArray(value)) { if (value != null) unavailable(source, 'structured-content', '未解释的结构化内容未作通用原始数据展示。', item); return []; }
    return value.flatMap((value, index): EvidenceBlock[] => {
      const block = object(value); const type = string(block.type) || 'unknown';
      const kind = `${label}.content[${index + 1}].${type}`;
      if (hidden.has(type)) { cover(source, kind, 'excluded', '隐藏推理不进入公开过程。', item); return []; }
      if (type === 'text' && typeof block.text === 'string') {
        cover(source, kind, 'displayed', '保留当时可取得的公开文本。', item);
        return [textBlock(label, publicText(block.text, source, item))];
      }
      if (type === 'tool_reference' && item.title === 'ToolSearch' && typeof block.tool_name === 'string' && block.tool_name.trim()) {
        cover(source, kind, 'displayed', '只显示 ToolSearch 返回的工具引用名；未加载定义，也不代表工具已调用或执行成功。', item);
        if (Object.keys(block).some(key => !['type', 'tool_name'].includes(key))) unavailable(source, `${kind}:additional-fields`, '工具引用还有未识别字段；仅展示已识别的引用名，不加载定义或展示其他原始字段。', item);
        return [textBlock('ToolSearch 返回的工具引用（不代表调用）', block.tool_name)];
      }
      if (type === 'image') {
        const image = object(block.source);
        const mime = string(image.media_type); const encoded = string(image.data).replace(/\s/g, '');
        if (image.type === 'base64' && /^(image\/png|image\/jpeg)$/.test(mime) && encoded.length <= 16 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 === 0) {
          const bytes = Buffer.from(encoded, 'base64');
          const signature = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
          if (signature) {
            cover(source, kind, 'displayed', '保留内嵌图像字节；来源可得不等于已通过原 UI 对照。', item);
            return [{ kind: 'image', label: '记录中的图像', mime, data: encoded }];
          }
        }
        unavailable(source, kind, '图像来源不是已识别的有界内嵌 PNG/JPEG；未读取 URL 或当前文件。', item);
        return [];
      }
      unavailable(source, kind, '此内容块未支持；保留类型与来源，不静默排除。', item); return [];
    });
  };
  const taskNotification = (ref: SourceRef, raw: string) => {
    const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(raw)?.[1].trim();
    const id = field('task-id');
    const status = field('status');
    const called = calls.get(field('tool-use-id') ?? '');
    const task = (id ? tasks.get(id) : undefined) ?? (called?.title === 'Workflow' ? called : undefined);
    if (task?.backgroundTask) task.backgroundTask.state = status === 'killed' ? 'stopped' : 'returned';
    // A workflow done: how it ended, and how long it ran, from the notification or else from when it started.
    if (task?.title === 'Workflow') {
      task.status = status === 'failed' ? 'failed' : status === 'killed' ? task.status : status === 'completed' ? 'completed' : task.status;
      if (status === 'killed') task.interrupted = true;
      const reported = Number(field('duration_ms')), started = Date.parse(task.timestamp ?? ''), heard = Date.parse(timestamp ?? '');
      const durationMs = field('duration_ms') && Number.isFinite(reported) ? reported : Number.isFinite(started) && Number.isFinite(heard) && heard >= started ? heard - started : undefined;
      if (durationMs !== undefined) task.agentUsage = { ...task.agentUsage, durationMs };
    }
    const agent = id ? agents.get(id) : undefined;
    if (!agent) {
      // A background command or monitor reporting back: one row saying what
      // finished, in the notification's own words, not an empty subtask.
      const said = field('summary') ?? '';
      const tool = /^Background command\b/.test(said) ? 'Bash' : /^Agent\b/.test(said) ? 'Agent' : /\bArtifact\b/.test(said) ? 'Artifact'
        : calls.get(field('tool-use-id') ?? '')?.title ?? 'Task';
      const item = add(ref, 'notice', /"([^"]+)"/.exec(said)?.[1] ?? (said || '后台任务通知'), said || '后台任务通知');
      item.noticeType = 'task-notification'; item.taskTool = tool;
      const exit = /exit code (-?\d+)/.exec(said);
      if (exit) item.exitCode = Number(exit[1]);
      item.status = status === 'failed' || (exit && exit[1] !== '0') ? 'failed' : status === 'completed' ? 'completed' : 'unknown';
      if (status === 'killed') item.interrupted = true;
      append(item, [textBlock('后台任务通知', said || raw), ...(field('output-file') ? [textBlock('记录中的输出文件路径（未读取）', field('output-file')!)] : [])]);
      cover(ref, 'task-notification', 'displayed', '后台任务的结束通知；按通知自身的摘要与状态显示，不读取输出文件。', item);
      return;
    }
    // Where the agent heard back, a row in the turn it heard in: what follows is the agent's answer to it.
    let input: Obj = {};
    try { input = object(JSON.parse(callInputs.get(field('tool-use-id') ?? '') ?? '{}')); } catch { /* No recorded input: the row says Agent. */ }
    const back = add(ref, 'notice', short(string(input.description)) || 'Agent', field('summary') ?? '后台任务通知');
    back.noticeType = 'task-notification'; back.taskTool = 'Agent';
    back.status = status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'unknown';
    if (status === 'killed') back.interrupted = true;
    append(back, [textBlock('后台任务通知', field('summary') || raw)]);
    const item = agent;
    // What the subagent cost, as the notification reports it: <usage><subagent_tokens>…<tool_uses>…<duration_ms>….
    const count = (name: string) => { const value = Number(field(name)); return Number.isFinite(value) && value >= 0 && field(name) ? value : undefined; };
    const usage = { tokens: count('subagent_tokens'), toolUses: count('tool_uses'), durationMs: count('duration_ms') };
    if (Object.values(usage).some(value => value !== undefined)) item.agentUsage = Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined));
    observeResult(item, 'readable');
    addSource(item, ref); append(item, [textBlock('父会话收到的通知', raw)], '这里只核对父会话通知，不代表子任务内部过程完整。');
    if (status === 'completed' && item.status !== 'failed') { item.status = 'completed'; item.summary = '已取得子任务完成通知；内部过程仍未关联加载。'; }
    else if (status === 'failed') { item.status = 'failed'; item.summary = '来源报告子任务失败；保留父会话收到的通知。'; }
    cover(ref, 'task-notification', 'merged', '按 task-id 关联已知子任务；未取得关联时单独标明通知来源。', item);
  };
  let line = 0;
  for (;;) {
    const rawLine = yield data;
    if (rawLine === null) break;
    line++;
    if (typeof rawLine === 'string' && !rawLine.trim()) continue;
    let r: Obj;
    try {
      r = object(typeof rawLine === 'string' ? JSON.parse(rawLine) : rawLine.record);
      if (!Object.keys(r).length) throw new Error('not an object');
    } catch {
      data.coverage.push({ source: { file: input.file, line }, kind: 'invalid-jsonl', disposition: 'unsupported', reason: '记录未完整写入或无法解码，未展示原始片段。' });
      data.warnings.push(`第 ${line} 行无法解码；其后完整记录仍会处理。`);
      continue;
    }
    timestamp = sourceTimestamp(r.timestamp);
    const source: SourceRef = { file: input.file, line, ...(string(r.uuid) ? { recordId: r.uuid } : {}) };
    const type = string(r.type) || 'unknown';
    if (type === 'history-suppression' && Object.keys(r).every(key => ['type', 'sessionId', 'ts', 'cause', 'vetoedAgainstAccountUuid'].includes(key))) {
      cover(source, type, 'excluded', '历史保存控制元数据，不是对话内容；不显示账户或控制字段。'); continue;
    }
    if (metadata.has(type)) {
      if (type === 'ai-title' && typeof r.sessionId === 'string' && r.sessionId.trim() && r.sessionId === data.id) {
        const title = explicitSessionTitle(r.aiTitle);
        if (title) { data.title = title; data.titleSource = 'claude-ai-title'; }
      }
      cover(source, type, 'excluded', type === 'ai-title' ? '会话名称元数据只用于匹配会话的标题，不计作请求或过程正文。' : '运行元数据不计作用户提问或公开过程正文。');
      continue;
    }
    if (type === 'file-history-snapshot' || type === 'file-history-delta') { cover(source, type, 'excluded', '历史索引不是版本内容；空备份不证明没有文件修改。'); continue; }
    if (type === 'attachment') {
      const a = object(r.attachment);
      if (a.type === 'edited_text_file') {
        const item = add(source, 'file-change', '记录中的文件片段', string(a.filename));
        item.result = typeof a.snippet === 'string' ? a.snippet.trim() ? 'readable' : 'empty' : 'unreadable';
        append(item, string(a.snippet) ? [textBlock('当时记录的片段', a.snippet, 'code')] : [], '仅取得附件中的片段；不是完整文件历史或 before/after diff。');
        cover(source, 'attachment:edited_text_file', 'displayed', '文件片段按来源边界展示。', item);
      } else if (injectedAttachments.has(string(a.type))) cover(source, `attachment:${string(a.type)}`, 'excluded', '已识别的运行附带上下文，不当作用户上传附件或新请求。');
      else if (a.type === 'queued_command' && /^\s*<task-notification>/.test(string(a.prompt))) taskNotification(source, string(a.prompt));
      else if (a.type === 'queued_command' && object(a.origin).kind === 'human' && publicText(string(a.prompt), source).trim()) {
        // Typed while the agent was working and absorbed into the running turn:
        // the reader's own words, kept in that turn instead of opening a new one.
        const said = publicText(string(a.prompt), source).trim();
        const item = add(source, 'request', '用户请求', short(said));
        if (said !== item.summary) append(item, [textBlock('用户请求', said)]);
        cover(source, 'attachment:queued_command', 'displayed', '运行中排队、并入当前回合的用户消息。', item);
      }
      else unavailable(source, `attachment:${string(a.type) || 'unknown'}`, '附件类型尚未识别；保留类型和来源，不展示其原始正文。');
      continue;
    }
    if (type === 'system') {
      if (r.subtype === 'compact_boundary') { const item = add(source, 'notice', '上下文已压缩', ''); item.noticeType = 'context-compacted'; cover(source, 'system:compact_boundary', 'displayed', '只显示影响上下文的边界，不显示内部指令。', item); }
      else if (r.subtype === 'turn_duration' && turn) {
        // Claude Code's own end-of-turn record: the turn is over, with its measured duration.
        const item = add(source, 'notice', '回合结束', '来源记录了回合结束；不代表每个工具或子任务成功。'); item.status = 'completed'; closedTurns.add(turn);
        if (Number.isFinite(r.durationMs) && r.durationMs >= 0) item.durationMs = r.durationMs;
        cover(source, 'system:turn_duration', 'displayed', '只作为回合结束边界及原生时长，不显示其他运行数据。', item);
      }
      else cover(source, `system:${string(r.subtype)}`, 'excluded', '系统运行记录不默认成为过程正文。');
      continue;
    }
    if (!['assistant', 'user'].includes(type)) { unavailable(source, type, '未识别的记录类型；仅保留类型与来源。'); continue; }
    const message = object(r.message);
    const values: unknown[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
    if (['system', 'developer'].includes(string(message.role)) || message.role === 'analysis' || message.channel === 'analysis') {
      cover(source, type, 'excluded', '系统与开发者指令不展示。');
      values.forEach((b, i) => cover({ ...source, block: i + 1 }, string(object(b).type) || 'content-block', 'excluded', '系统与开发者指令不展示。')); continue;
    }
    if (!values.length) {
      if (message.content != null && typeof message.content !== 'string' && !Array.isArray(message.content)) unavailable(source, `${type}:structured-message`, '消息内容形态尚未识别；保留来源，不展示原始对象。');
      else cover(source, type, 'excluded', '无可取得的消息内容块。');
      continue;
    }
    if (type === 'user' && r.isCompactSummary === true) {
      // After a compaction Claude Code writes the summary of what came before for the agent: not a request, and no new turn.
      cover(source, 'user:compact-summary', 'excluded', '压缩后写给 Agent 的前文摘要，不是用户请求；压缩本身以边界提示显示。'); continue;
    }
    if (r.isMeta === true || r.sourceToolUseID) {
      cover(source, `${type}:injected`, 'excluded', '技能或运行上下文注入，不是用户新要求，不显示指令正文。');
      values.forEach((b, i) => cover({ ...source, block: i + 1 }, string(object(b).type) || 'content-block', 'excluded', '自动注入正文不作公开展示。')); continue;
    }
    // Screenshots pasted with a request belong to that request, whichever block comes first.
    const pasted: Array<{ value: unknown; ref: SourceRef }> = [];
    // The editor's selection is recorded before the words it came with; the words lead the request.
    const inOrder = values.map((value, index) => ({ value, index }))
      .sort((a, b) => Number(type === 'user' && editorContext(string(object(a.value).text))) - Number(type === 'user' && editorContext(string(object(b.value).text))));
    inOrder.forEach(({ value, index }) => {
      const block = object(value); const blockType = string(block.type) || 'unknown';
      const ref = { ...source, block: index + 1 };
      if (type === 'user' && blockType === 'image') { pasted.push({ value, ref }); return; }
      if (hidden.has(blockType)) {
        // A visible phase marker is not a reader for private, redacted or absent thought text.
        if (type === 'assistant' && blockType === 'thinking') {
          const key = `${message.id || r.uuid || line}:${r.apiBlockIndex ?? index}:thinking`;
          // Claude Code writes a short summary into some thinking blocks and shows it
          // in its own UI. That text is public process; the signature never is.
          const said = string(block.thinking).trim();
          if (said) {
            const seen = seenBlocks.get(key);
            if (seen?.item && seen.text === said) { addSource(seen.item, ref); cover(ref, 'thinking-summary', 'merged', '同一思考块再次出现，摘要相同。', seen.item); return; }
            const item = add(ref, 'message', '思考摘要', short(said));
            if (said !== item.summary) append(item, [textBlock('公开正文', said)]);
            seenBlocks.set(key, { item, text: said });
            cover(ref, 'thinking-summary', 'displayed', 'Claude Code 界面中显示的思考摘要；签名不读取。', item);
            return;
          }
          const prior = seenBlocks.get(key)?.item;
          const item = prior ?? add(ref, 'notice', '思考', '仅记录思考阶段；没有可展示的思考正文。');
          if (prior) addSource(prior, ref);
          seenBlocks.set(key, { item, text: '' });
          cover(ref, 'thinking-phase', prior ? 'merged' : 'displayed', '只显示来源中的思考阶段，不读取或复现隐藏推理正文。', item);
        }
        cover(ref, blockType, 'excluded', '隐藏推理不进入公开过程。'); return;
      }
      const blockKey = message.id && Number.isInteger(r.apiBlockIndex) ? `${message.id}:${r.apiBlockIndex}:${index}:${blockType}` : r.uuid ? `${r.uuid}:${index}:${blockType}` : undefined;
      // Only identical text under an explicit source identity is a duplicate.
      // A later version of the same block is preserved as a version, not dropped.
      const previous = blockKey ? seenBlocks.get(blockKey) : undefined;
      if (blockType === 'text' && previous && previous.text === block.text) {
        const item = previous.item;
        if (item) {
          addSource(item, ref);
          if (type === 'assistant' && message.stop_reason === 'end_turn' && item.kind === 'message') { item.kind = 'answer'; item.title = '历史回答'; append(item, item.detail ? [] : [textBlock('公开正文', previous.text)]); }
        }
        cover(ref, blockType, 'merged', '同一消息块身份及相同公开正文再次出现。', item); return;
      }
      if (blockType === 'tool_use') {
        const id = string(block.id); const name = string(block.name);
        if (!id) { unavailable(ref, 'tool_use', '调用缺少身份标识，不猜测结果归属。'); return; }
        const args = object(block.input);
        const mcpInput = sampledMcpInput(name, args);
        const displayInput = knownTools.has(name) ? args : mcpInput?.value;
        const recordedInput = displayInput ? JSON.stringify(displayInput, null, 2) : undefined;
        if (calls.has(id)) {
          const item = calls.get(id)!; addSource(item, ref);
          if (recordedInput && callInputs.get(id) !== recordedInput) {
            append(item, [textBlock('同一调用 ID 的另一组记录参数', recordedInput, 'json')], '同一调用 ID 的参数记录不一致；保留可取得的版本，不推断为再次执行。');
            callInputs.set(id, recordedInput);
          }
          if (mcpInput && !mcpInput.value) unavailable(ref, `tool-input:${name}`, '同一调用 ID 的后续参数结构未识别；保留已有的已识别参数。', item);
          if (mcpInput?.extraFields) unavailable(ref, `tool-input:${name}:additional-fields`, '后续参数还有未识别字段；不直接展示其原始内容。', item);
          cover(ref, 'tool_use', 'merged', '同一调用 ID 关联到已有调用；不同的已识别参数版本明确保留。', item); return;
        }
        const kind: ItemKind = name === 'AskUserQuestion' ? 'question' : ['Agent', 'Task'].includes(name) ? 'subagent' : ['Edit', 'Write'].includes(name) ? 'file-change' : 'tool';
        const summary = short(string(args.command) || string(args.file_path) || string(args.pattern) || string(args.description) || string(args.skill) || '已记录调用输入，尚未取得最终状态。');
        const item = add(ref, kind, name || '工具调用', summary); item.status = 'unknown'; item.result = 'not-observed'; item.callId = id; calls.set(id, item);
        if (recordedInput) callInputs.set(id, recordedInput);
        // Stopping a task is the record's only word that it will not report back.
        const stopped = name === 'TaskStop' ? tasks.get(string(args.task_id) || string(args.shell_id))?.backgroundTask : undefined;
        if (stopped) stopped.state = 'stopped';
        if (displayInput) append(item, Object.keys(displayInput).length ? [textBlock('当时调用参数', JSON.stringify(displayInput, null, 2), 'json')] : []);
        else unavailable(ref, `tool-input:${name}`, '新工具的参数展示范围未确认；不直接展示全部原始参数。', item);
        if (mcpInput?.extraFields) unavailable(ref, `tool-input:${name}:additional-fields`, '此工具还有未识别的参数字段；仅展示已盘点并通过结构验证的字段。', item);
        if (kind === 'subagent') append(item, [], '当前只接入父会话记录；子任务内部过程尚未关联加载。');
        if (name === 'Artifact') append(item, [], '仅有 Artifact 调用／引用；没有加载其目标内容或交互。');
        if (kind === 'file-change') append(item, [], '这是修改请求；是否应用以对应返回为准，不代表当前文件或完整回合 diff。');
        cover(ref, 'tool_use', 'displayed', '按调用 ID 记录输入及可取得状态。', item);
        return;
      }
      if (blockType === 'tool_result') {
        const callId = string(block.tool_use_id);
        const item = calls.get(callId) ?? add(ref, 'tool', '未配对工具结果', '没有取得对应调用；仅展示本条结果来源。');
        if (!calls.has(callId)) { item.status = 'unknown'; data.warnings.push(`第 ${line} 行没有找到 tool_use_id 对应调用。`); }
        addSource(item, ref);
        const structured = object(r.toolUseResult);
        const outputCoverageStart = data.coverage.length;
        let resultContent = block.content;
        let excludedRuntimeWrapper = false;
        if (item.kind === 'subagent') {
          const values = typeof resultContent === 'string' ? [{ type: 'text', text: resultContent }] : Array.isArray(resultContent) ? resultContent : undefined;
          if (values) {
            resultContent = values.filter((value, index) => {
              const content = object(value);
              if (content.type !== 'text' || typeof content.text !== 'string' || !asyncLaunchWrapper(content.text, structured)) return true;
              excludedRuntimeWrapper = true;
              cover(ref, `tool_result:async-launch-runtime-wrapper.content[${index + 1}]`, 'excluded', '结构化异步启动状态与已识别的内部指导模板同时吻合；指导正文不作为子任务返回展示。', item);
              return false;
            });
          }
        }
        const output = contentBlocks(resultContent, ref, item, '当时返回');
        // Keep this returned-content batch separate from the item's input details.
        // Unknown input schemas and scope notices cannot turn readable output partial.
        const returned = [...output];
        if (excludedRuntimeWrapper) returned.push(textBlock('当时异步启动状态', JSON.stringify({ status: structured.status, isAsync: structured.isAsync }, null, 2), 'json'));
        if (item.kind === 'question' && (structured.questions || structured.answers)) returned.push(textBlock('问题及记录的回答', JSON.stringify({ questions: structured.questions, answers: structured.answers, annotations: structured.annotations }, null, 2), 'json'));
        // An edit's result carries the change as Claude Code drew it: hunks with their line numbers and context.
        const patch = recordedPatch(structured);
        if (patch) returned.push(textBlock(patch.path, patch.text, 'patch'));
        if (structured.stdout && !output.some(b => b.text === structured.stdout)) returned.push(textBlock('记录的 stdout', publicText(string(structured.stdout), ref, item)));
        if (structured.stderr && !output.some(b => b.text === structured.stderr)) returned.push(textBlock('记录的 stderr（不单独判定失败）', publicText(string(structured.stderr), ref, item)));
        append(item, returned);
        // Account for sibling payloads without becoming a generic structured
        // reader. Only sampled delivery metadata and independently matched
        // image/tool-reference mirrors are exempt from unsupported accounting.
        const known = new Set(['stdout', 'stderr', 'exit_code', 'exitCode', 'interrupted', 'status', 'success', 'isAsync']);
        const metadataFields: Record<string, string[]> = {
          Bash: ['isImage', 'noOutputExpected', 'returnCodeInterpretation'],
          Skill: ['commandName'],
          SendMessage: ['message', 'resumedAgentId', 'pin'],
          ToolSearch: ['query', 'total_deferred_tools'],
          Read: ['type'],
          AskUserQuestion: ['questions', 'answers', 'annotations'],
          Agent: ['agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile'],
          Task: ['agentId', 'description', 'resolvedModel', 'prompt', 'outputFile', 'canReadOutputFile'],
          Artifact: ['artifact_id', 'audience', 'capabilities', 'contract', 'liveSubscription', 'path', 'stored', 'title', 'updated', 'url', 'version'],
        };
        for (const key of metadataFields[item.title] ?? []) known.add(key);
        if (patch) known.add('structuredPatch');
        // Claude Code says whether a Write made the file or replaced it; a new file has no patch to tell.
        if (item.title === 'Write' && (structured.type === 'create' || structured.type === 'update')) { item.fileOperation = structured.type; known.add('type'); }
        const file = object(structured.file);
        if (item.title === 'Read' && typeof file.base64 === 'string' && Object.keys(file).every(key => ['base64', 'type', 'originalSize', 'dimensions'].includes(key)) && returned.some(b => b.kind === 'image' && b.data === file.base64.replace(/\s/g, ''))) known.add('file');
        if (item.title === 'ToolSearch' && Array.isArray(structured.matches)) {
          const refs = Array.isArray(resultContent) ? resultContent.filter(b => object(b).type === 'tool_reference').map(b => object(b).tool_name) : [];
          if (structured.matches.length === refs.length && structured.matches.every((name: unknown, index: number) => typeof name === 'string' && name === refs[index])) known.add('matches');
        }
        if (Object.keys(structured).some(key => !known.has(key))) unavailable(ref, 'tool-result:additional-fields', '返回记录还有未解释的载荷字段；只保留来源，不展示原始对象，也不视作空返回。', item);
        const readable = returned.some(b => b.kind === 'image' ? !!b.data : !!b.text?.trim());
        const empty = emptyReturn(resultContent) || (resultContent == null && [structured.stdout, structured.stderr].some(v => typeof v === 'string') && [structured.stdout, structured.stderr].every(v => v === undefined || (typeof v === 'string' && !v.trim())));
        const unreadable = data.coverage.slice(outputCoverageStart).some(c => c.disposition === 'unsupported' || (c.disposition === 'excluded' && hidden.has(c.kind.split('.').at(-1)!))) || [structured.stdout, structured.stderr].some(v => v !== undefined && typeof v !== 'string') || (!readable && !empty);
        observeResult(item, unreadable ? readable ? 'partial' : 'unreadable' : readable ? 'readable' : 'empty');
        const exitCode = typeof structured.exit_code === 'number' ? structured.exit_code : typeof structured.exitCode === 'number' ? structured.exitCode : undefined;
        // Record only what the source wrote: a structured code, or the harness's
        // own `Error: Exit code N` prefix on a result it flagged as an error.
        const contentText = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(part => string(object(part).text)).join('\n') : '';
        const prefixed = block.is_error === true
          ? claudeExitPrefix(typeof r.toolUseResult === 'string' ? r.toolUseResult : contentText) : undefined;
        if (exitCode !== undefined) item.exitCode = exitCode; else if (prefixed) item.exitCode = prefixed.exitCode;
        if (typeof r.toolDenialKind === 'string' && r.toolDenialKind) item.denial = r.toolDenialKind;
        if (structured.interrupted === true) item.interrupted = true;
        if (block.is_error === true || structured.interrupted === true || structured.status === 'failed' || (exitCode !== undefined && exitCode !== 0)) item.status = 'failed';
        else if (structured.status === 'async_launched' || structured.isAsync === true) { item.status = 'running'; append(item, [], '本次返回仅为异步启动记录；最终状态以另行取得的后续通知为准。'); }
        else if (item.status !== 'failed') item.status = block.is_error === false || structured.status === 'completed' || structured.success === true || exitCode === 0 ? 'completed' : 'unknown';
        if (item.kind === 'subagent' && typeof structured.agentId === 'string') { agents.set(structured.agentId, item); item.agentId = structured.agentId; }
        const backgroundId = structured.status === 'async_launched' && typeof structured.agentId === 'string' ? structured.agentId
          : typeof structured.backgroundTaskId === 'string' ? structured.backgroundTaskId : undefined;
        if (backgroundId) { item.backgroundTask = { id: backgroundId, state: 'running' }; tasks.set(backgroundId, item); }
        // A workflow runs in the background by definition: it returns at once, and a notification says when it is done.
        else if (item.title === 'Workflow' && item.status !== 'failed') {
          const taskId = string(structured.taskId) || string(structured.task_id) || callId;
          item.backgroundTask = { id: taskId, state: 'running' }; tasks.set(taskId, item);
          if (item.status === 'completed') item.status = 'running';
        }
        const raw = output.map(b => b.text ?? '').join('\n');
        if (/^(?:Warning: truncated output|\[output truncated\])/im.test(raw)) append(item, [], '来源输出已截断，只展示实际取得的片段。');
        if (returned.some(b => /^(?:Warning: truncated output|\[output truncated\])/im.test(b.text ?? ''))) observeResult(item, 'partial');
        if (item.title === 'Artifact') append(item, [], 'Artifact 结果只提供引用／元数据，不计为内容已呈现。');
        item.summary = item.status === 'failed' ? '来源报告错误或中断；保留本次调用与返回。' : item.status === 'running' ? '已取得启动／阶段信息，尚未完成。' : item.status === 'completed' ? '记录中调用已结束；可核对当时输入与返回。' : '已取得返回，最终成功状态未确认。';
        cover(ref, 'tool_result', 'merged', '结果按 tool_use_id 关联调用；非空 stderr 不直接判失败。', item);
        return;
      }
      if (blockType === 'text' && typeof block.text === 'string') {
        const raw = publicText(block.text, ref);
        if (type === 'user' && interruptionPlaceholder(raw)) {
          // The harness's own stop marker: it ends the turn, it is not a new request.
          const item = add(ref, 'notice', '回合中断', '来源记录了本回合中断；不代表已启动的命令或子任务全部停止。'); item.status = 'unknown';
          if (turn) closedTurns.add(turn);
          cover(ref, 'user:interruption-placeholder', 'displayed', '系统生成的中断占位文字只作为回合中断边界，不计作新用户请求。', item); return;
        }
        if (!raw.trim()) { cover(ref, 'text:empty-or-injected', 'excluded', '正文为空或仅有自动提醒。'); return; }
        if (type === 'user' && openedFileOnly(raw)) { cover(ref, 'user:ide-opened-file', 'excluded', '编辑器中打开的文件，随请求自动附带，不是用户写的话。'); return; }
        if (type === 'user' && injected(raw)) { cover(ref, 'user:injected', 'excluded', '命令、技能或环境注入，不是用户新问题。'); return; }
        if (type === 'user' && /^\s*<task-notification>/.test(raw)) { taskNotification(ref, raw); return; }
        const apiError = r.isApiErrorMessage === true;
        const kind: ItemKind = apiError ? 'notice' : type === 'user' ? 'request' : message.stop_reason === 'end_turn' ? 'answer' : 'message';
        let request = type === 'user' ? typedCommand(raw) ?? raw : raw; let background = '';
        if (type === 'user' && /^# Context from my IDE setup:/m.test(raw)) {
          const split = /^## My request:\s*$/m.exec(raw);
          if (!split) { cover(ref, 'user:ide-context', 'excluded', '只有 IDE 上下文，不另计为新问题。'); return; }
          background = raw.slice(0, split.index).trim(); request = raw.slice(split.index + split[0].length).trim();
        }
        const key = `${message.id || r.uuid || `line:${line}`}:${type}`;
        let item = messages.get(key);
        const merged = !!item;
        if (!item) {
          // Additional blocks or revisions of an existing request do not start
          // another turn or retarget records away from the current request.
          const parent = string(r.parentUuid), sibling = kind === 'request' && parent ? requestParents.get(parent) : undefined;
          if (sibling?.turnId && !closedTurns.has(sibling.turnId)) {
            // Esc before any output puts the prompt back in the input box and writes
            // no stop marker; the resent request then hangs off the same parent.
            const stop = add(ref, 'notice', '回合中断', '在 Agent 回应前中断；随后重新发送了请求。');
            stop.turnId = sibling.turnId; stop.status = 'unknown'; closedTurns.add(sibling.turnId);
            cover(ref, 'user:resent-request', 'displayed', '同一父记录下再次提问：前一条在回应前被中断，来源未写中断标记。', stop);
          }
          if (kind === 'request') turn = string(r.uuid) || `turn:${line}`;
          item = add(ref, kind, apiError ? 'API 错误' : kind === 'request' ? '用户请求' : kind === 'answer' ? '历史回答' : '过程说明', short(request));
          messages.set(key, item);
          if (kind === 'request' && parent) requestParents.set(parent, item);
        } else {
          addSource(item, ref);
          if (!item.detail) append(item, [textBlock('先前公开文本块', item.summary)]);
          append(item, [textBlock(previous ? '同一正文块的后续版本' : '后续公开文本块', request)]);
          if (previous) append(item, [], '同一消息块在来源中出现了不同版本；保留各版公开正文，不推断为用户重复提问。');
        }
        if (kind === 'answer' && item.kind === 'message') { item.kind = 'answer'; item.title = '历史回答'; }
        if (!merged && (kind === 'answer' || request !== item.summary || background)) append(item, [textBlock('用户请求或公开正文', request), ...(background ? [textBlock('随请求附带的 IDE 背景', background)] : [])]);
        if (apiError) item.status = 'failed';
        if (kind === 'request' && data.title === 'Claude Code session' && data.titleSource !== 'claude-ai-title') { data.title = short(plainPasted(request)); data.titleSource = 'request'; }
        cover(ref, blockType, kind === 'answer' ? 'original-chat' : merged ? 'merged' : 'displayed', '保留公开消息及多块身份关系；完整回答主要在原聊天阅读。', item);
        if (blockKey) seenBlocks.set(blockKey, { item, text: block.text });
        return;
      }
      unavailable(ref, blockType, '尚未支持的消息内容块，不直接展示原始数据。');
    });
    if (pasted.length) {
      const key = `${message.id || r.uuid || `line:${line}`}:user`;
      let request = messages.get(key);
      if (!request) {
        turn = string(r.uuid) || `turn:${line}`;
        request = add(pasted[0].ref, 'request', '用户请求', '（仅附图）');
        messages.set(key, request);
      }
      for (const { value, ref } of pasted) { addSource(request, ref); append(request, contentBlocks([value], ref, request, '附图')); }
    }
  }
  for (const item of data.items) if (item.availability === 'partial' && !item.detail) item.availability = 'unavailable';
  return data;
}
