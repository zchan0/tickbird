/** UI labels only. Agent-authored content and tool names are never translated. */
const messages = {
  compacted: ['上下文已压缩', 'Context compacted'],
  compactionSummary: ['压缩摘要', 'Compaction summary'],
} as const;
export function uiLabel(key: keyof typeof messages, locale = 'zh-cn'): string {
  return messages[key][/^zh(?:-|$)/i.test(locale) ? 0 : 1];
}
