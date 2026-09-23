/**
 * Claude Code wraps text pasted into a prompt as
 * `<pasted_content id="…">…</pasted_content id="…">`. The tags are transport,
 * not words the user wrote; the body inside them is kept verbatim.
 */
export interface UserTextSegment { text: string; pasted: boolean }

const PAIR = /<pasted_content id="([^"\n]{1,64})">\r?\n?([\s\S]*?)\r?\n?<\/pasted_content id="\1">/g;
// A summary cut at a length budget can keep an opening tag without its close,
// or end inside the tag itself.
const ORPHAN = /<\/?pasted_content(?:\s[^>]*)?(?:>|$)/g;

export function pastedSegments(text: string): UserTextSegment[] {
  const segments: UserTextSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(PAIR)) {
    segments.push({ text: text.slice(at, match.index).replace(ORPHAN, ''), pasted: false }, { text: match[2], pasted: true });
    at = match.index + match[0].length;
  }
  segments.push({ text: text.slice(at).replace(ORPHAN, ''), pasted: false });
  return segments.filter(segment => segment.pasted || segment.text.trim());
}

/** The same text with the transport tags removed, for one-line and plain-text uses. */
export const plainPasted = (text: string): string => text.replace(PAIR, (_, _id, body: string) => body).replace(ORPHAN, '');
