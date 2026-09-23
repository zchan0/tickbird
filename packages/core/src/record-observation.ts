import { createHash } from 'node:crypto';
import type { Provider } from './model';
import type { RecordFrame } from './record-stream';
import { sourceTimestamp } from './jsonl';

type Obj = Record<string, any>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const key = (value: unknown): string | undefined => typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex').slice(0, 24) : undefined;
const tool = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_./-]{1,180}$/.test(value) ? value : undefined;

export interface RecordObservation {
  category: string;
  sourceTime?: string;
  turnKey?: string;
  callKey?: string;
  messageKey?: string;
  toolName?: string;
}

/** Metadata-only source probe, NOT the content adapter or a global support claim. */
export function observeRecord(provider: Provider, frame: RecordFrame): RecordObservation[] {
  if (frame.kind !== 'json') return [{ category: frame.kind }];
  const r = object(frame.value);
  const sourceTime = sourceTimestamp(r.timestamp);
  const make = (category: string, extra: Partial<RecordObservation> = {}): RecordObservation => ({ category, ...(sourceTime ? { sourceTime } : {}), ...extra });
  if (provider === 'codex') {
    const p = object(r.payload);
    const turnKey = key(p.turn_id ?? object(p.internal_chat_message_metadata_passthrough).turn_id);
    if (r.type === 'session_meta') return [make('session-identity')];
    if (r.type === 'turn_context') return [make('turn-context', { turnKey })];
    if (r.type === 'event_msg') {
      const types: Record<string, string> = {
        task_started: 'turn-start', task_complete: 'turn-end', task_aborted: 'turn-interrupted', turn_aborted: 'turn-interrupted',
        agent_message: 'agent-message-event', user_message: 'user-message-event',
        agent_reasoning: 'private-reasoning-presence', token_count: 'usage-metadata',
        sub_agent_message: 'subagent-return-event', sub_agent_activity: 'subagent-activity-event',
      };
      return [make(typeof p.type === 'string' && Object.hasOwn(types, p.type) ? types[p.type] : 'other-event', { turnKey })];
    }
    if (r.type !== 'response_item') return [make('other-record')];
    const callKey = key(p.call_id);
    if (['function_call', 'custom_tool_call', 'tool_call'].includes(p.type)) return [make('tool-call', { callKey, turnKey, toolName: tool(p.name) })];
    if (['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(p.type)) return [make('tool-output', { callKey, turnKey })];
    if (p.type === 'reasoning') return [make('private-reasoning-presence')];
    if (p.type === 'message') {
      if (p.role === 'user') return [make('user-message', { turnKey, messageKey: key(p.id) })];
      if (p.role !== 'assistant' || p.channel === 'analysis') return [make('non-public-message')];
      const category = p.phase === 'commentary' ? 'public-commentary' : p.phase === 'final_answer' ? 'final-answer' : 'assistant-text-unclassified';
      return [make(category, { turnKey, messageKey: key(p.id) })];
    }
    return [make('other-response')];
  }
  if (!['user', 'assistant'].includes(r.type)) {
    return [make(r.type === 'system' && r.subtype === 'turn_duration' ? 'turn-duration-record'
      : r.type === 'history-suppression' ? 'history-control' : 'other-record')];
  }
  const m = object(r.message);
  if (['system', 'developer', 'analysis'].includes(m.role) || m.channel === 'analysis') return [make('non-public-message')];
  const messageKey = key(m.id ?? r.uuid);
  const blocks = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text' }] : [];
  const observations: RecordObservation[] = blocks.map((b: unknown) => {
    const block = object(b);
    if (block.type === 'tool_use') return make('tool-call', { messageKey, callKey: key(block.id), toolName: tool(block.name) });
    if (block.type === 'tool_result') return make('tool-output', { messageKey, callKey: key(block.tool_use_id) });
    if (['thinking', 'redacted_thinking'].includes(block.type)) return make('private-reasoning-presence', { messageKey });
    if (block.type !== 'text') return make('other-content-block', { messageKey });
    if (r.type === 'user') return make(r.isMeta || r.sourceToolUseID || r.isCompactSummary ? 'injected-user-envelope' : 'user-text-envelope', { messageKey });
    return make(m.stop_reason === 'end_turn' ? 'answer-text' : 'assistant-text', { messageKey });
  });
  if (r.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(m.stop_reason)) observations.push(make('assistant-stop-record', { messageKey }));
  return observations.length ? observations : [make('empty-message')];
}
