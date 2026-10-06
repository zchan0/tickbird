/**
 * Terminal cells. CJK and most emoji take two columns; combining marks and
 * zero-width joiners take none. Good enough for a narrow side pane, not a full
 * Unicode width table.
 */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];
const ZERO: Array<[number, number]> = [[0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xe0100, 0xe01ef]];
const within = (ranges: Array<[number, number]>, cp: number) => ranges.some(([from, to]) => cp >= from && cp <= to);

export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || within(ZERO, cp)) return 0;
  return within(WIDE, cp) ? 2 : 1;
}

export const textWidth = (text: string): number => [...text].reduce((sum, char) => sum + charWidth(char.codePointAt(0)!), 0);

/**
 * Transcript text is untrusted: an escape sequence in a tool's output must not
 * reach the terminal as a command. Tabs become spaces; every other control goes.
 */
export const clean = (text: string): string => text.replace(/\t/g, '  ').replace(/\r\n?/g, '\n')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

/** One line, cut to `width` cells with an ellipsis when it does not fit. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (textWidth(text) <= width) return text;
  let out = '', used = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0)!);
    if (used + w > width - 1) break;
    out += char; used += w;
  }
  return out + '…';
}

// Characters of a Latin word, a path or a URL: none of them starts a new line on its own.
const WORD = /[A-Za-z0-9_\-./~`'":?=&%#@+]/;
// Closing punctuation never starts a line: it takes the character before it along.
const OPENING = /[（「『《【(\[]/;
const CLOSING = /[，。、；：！？）」』》】,.;:!?)\]]/;

/**
 * Hard-wraps each paragraph to `width` cells. A Latin word breaks at the space
 * before it; CJK text breaks anywhere, so a line is not left half empty.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of clean(text).split('\n')) {
    // Where the Latin word being written started: after a space, or after CJK text.
    let line = '', wordStart = -1;
    for (const char of paragraph) {
      const w = charWidth(char.codePointAt(0)!);
      const latin = WORD.test(char) && w === 1;
      if (textWidth(line) + w > width) {
        if (char === ' ') { lines.push(line.trimEnd()); line = ''; wordStart = -1; continue; }
        let carry = '';
        // A word moves whole, and so does a word that closing punctuation would otherwise split from.
        // (Only a word longer than a whole line is broken inside.)
        if ((latin || CLOSING.test(char)) && wordStart > 0 && textWidth(line.slice(wordStart)) + w <= width) {
          carry = line.slice(wordStart); line = line.slice(0, wordStart);
        } else if (CLOSING.test(char) && line.length > 1) {
          // Closing punctuation takes along the closing marks before it, then the word before those.
          const chars = [...line];
          const tail: string[] = [];
          while (chars.length > 1 && CLOSING.test(chars[chars.length - 1])) tail.unshift(chars.pop()!);
          let start = chars.length;
          while (start > 0 && WORD.test(chars[start - 1]) && charWidth(chars[start - 1].codePointAt(0)!) === 1) start--;
          const keep = start > 0 && start < chars.length && textWidth(chars.slice(start).join('') + tail.join('') + char) <= width ? start : chars.length - 1;
          carry = chars.splice(keep).join('') + tail.join(''); line = chars.join('');
        }
        // Opening punctuation never ends a line: it goes with what it opens.
        const trimmed = [...line.trimEnd()];
        while (carry && trimmed.length > 1 && OPENING.test(trimmed[trimmed.length - 1])) carry = trimmed.pop()! + carry;
        line = trimmed.join('');
        lines.push(line.trimEnd()); line = carry; wordStart = carry && latin ? 0 : -1;
      }
      if (!latin) wordStart = -1;
      else if (wordStart < 0) wordStart = line.length;
      line += char;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Pads with spaces to exactly `width` cells (after cutting). */
export const pad = (text: string, width: number): string => {
  const cut = fit(text, width);
  return cut + ' '.repeat(Math.max(0, width - textWidth(cut)));
};
