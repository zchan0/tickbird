import { t } from './i18n';

/**
 * Words the user sent along with a request, wrapped in tags:
 * - Claude Code wraps text pasted into a prompt as
 *   `<pasted_content id="…">…</pasted_content id="…">`.
 * - Claude Code in VS Code sends the lines selected in the editor as
 *   `<ide_selection>The user selected the lines 5 to 9 from /a/b.ts:\n…</ide_selection>`,
 *   and the file open in the editor as `<ide_opened_file>…</ide_opened_file>`.
 * The tags are transport, not words the user wrote. A paste's body and a
 * selection's lines are kept verbatim, set apart under a label; the open file
 * is the editor's state, not something the user sent, and is left out.
 */
export interface UserTextSegment { text: string; pasted: boolean; label?: string; /** A selection's file: its lines are code. */ path?: string }

const PAIR = /<pasted_content id="([^"\n]{1,64})">\r?\n?([\s\S]*?)\r?\n?<\/pasted_content id="\1">/g;
const SELECTION = /<ide_selection>(?:The user selected the lines (\d+) to (\d+) from ([^\n]+?):\r?\n)?([\s\S]*?)\s*(?:This may or may not be related to the current task\.)?\s*<\/ide_selection>/g;
const OPENED = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>\s*/g;
const BOTH = new RegExp(`${PAIR.source}|${SELECTION.source}`, 'g');
// A summary cut at a length budget can keep an opening tag without its close,
// or end inside the tag itself.
const ORPHAN = /<\/?pasted_content(?:\s[^>]*)?(?:>|$)|<ide_selection>[\s\S]*$|<ide_opened_file>[\s\S]*$/g;

const pastedLabel = (body: string): string => {
  const lines = body.split(/\r?\n/).length;
  return t(`Pasted · ${lines} ${lines === 1 ? 'line' : 'lines'}`, `粘贴的内容 · ${lines} 行`);
};
const selectionLabel = (from?: string, to?: string, path?: string): string => {
  const name = path?.split(/[\\/]/).pop() ?? '';
  if (!name) return t('Selected in the editor', '编辑器中选中的内容');
  return from === to ? t(`${name} · line ${from}`, `${name} · 第 ${from} 行`) : t(`${name} · lines ${from}–${to}`, `${name} · 第 ${from}–${to} 行`);
};

export function pastedSegments(text: string): UserTextSegment[] {
  const source = text.replace(OPENED, '');
  const segments: UserTextSegment[] = [];
  let at = 0;
  for (const match of source.matchAll(BOTH)) {
    segments.push({ text: source.slice(at, match.index).replace(ORPHAN, ''), pasted: false });
    segments.push(match[2] !== undefined
      ? { text: match[2], pasted: true, label: pastedLabel(match[2]) }
      : { text: match[6], pasted: true, label: selectionLabel(match[3], match[4], match[5]), path: match[5] ?? '' });
    at = match.index + match[0].length;
  }
  segments.push({ text: source.slice(at).replace(ORPHAN, ''), pasted: false });
  return segments.filter(segment => segment.pasted || segment.text.trim());
}

/**
 * The same text with the transport tags removed, for one-line and plain-text
 * uses: a paste's body in place, a selection by its label alone.
 */
export const plainPasted = (text: string): string => text.replace(OPENED, '')
  .replace(PAIR, (_, _id, body: string) => body)
  .replace(SELECTION, (_, from?: string, to?: string, path?: string) => selectionLabel(from, to, path))
  .replace(ORPHAN, '');

/** A block that is only the editor's selection or open file: context sent with the request, not its words. */
export const editorContext = (text: string): boolean => /^\s*<ide_(?:selection|opened_file)>/.test(text);
/** A block that is only the open file: the editor's state, never shown. */
export const openedFileOnly = (text: string): boolean => /<ide_opened_file>/.test(text) && !text.replace(OPENED, '').trim();
