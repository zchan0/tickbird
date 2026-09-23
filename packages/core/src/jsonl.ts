import type { ParseInput, SessionData } from './model';

export type ParserContext = Omit<ParseInput, 'text'> & { sessionId: string };
/** Yielded data is a borrowed live projection; evidence snapshots must be cloned. */
export type SessionParser = Generator<SessionData, SessionData, string | { record: unknown } | null>;

/** Iterate without retaining a second whole-file array of lines or raw records. */
export function* textLines(text: string): Generator<string> {
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n', start);
    if (end < 0) { yield text.slice(start).replace(/\r$/, ''); return; }
    yield text.slice(start, end).replace(/\r$/, '');
    start = end + 1;
  }
}

export function parseSnapshot(input: ParseInput, provider: 'codex' | 'claude', factory: (input: ParserContext) => SessionParser): SessionData {
  let sessionId = `${provider}:${input.file}`;
  for (const line of textLines(input.text)) {
    try {
      const record = JSON.parse(line);
      const id = provider === 'codex' ? record?.type === 'session_meta' && record.payload?.id
        : record?.type !== 'ai-title' && record?.sessionId;
      if (typeof id === 'string' && id.trim()) { sessionId = id; break; }
    } catch { /* The parser accounts for malformed source lines. */ }
  }
  const parser = factory({ file: input.file, projectPath: input.projectPath, sessionId });
  parser.next();
  for (const line of textLines(input.text)) parser.next(line);
  const result = parser.next(null);
  if (!result.done) throw new Error('会话解析未完成。');
  return result.value;
}

/** Source timestamp only; no clock/mtime-derived event time. */
export function sourceTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export const interruptionPlaceholder = (text: string): boolean => /^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim());
