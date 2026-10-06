import { charWidth, clean, textWidth } from './width';

/**
 * The 16 palette colours only, so every view follows the user's own terminal
 * theme. 'default' is the terminal's foreground.
 */
export type Color = 'default' | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite';

export interface Style {
  fg?: Color; bg?: Color;
  bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean;
  /** OSC 8 target; drawn only when the terminal shows links. */
  link?: string;
}

export interface Span { text: string; style?: Style }
/** One screen row. A string is unstyled text. */
export type Line = Span[] | string;

const COLORS: Color[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const colorCode = (color: Color, base: number): string => {
  if (color === 'default') return String(base + 9);
  const bright = color.startsWith('bright');
  const index = COLORS.indexOf((bright ? color.slice(6).toLowerCase() : color) as Color);
  return String((bright ? base + 60 : base) + index);
};

export function sgr(style: Style = {}): string {
  const codes = ['0'];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.inverse) codes.push('7');
  if (style.fg && style.fg !== 'default') codes.push(colorCode(style.fg, 30));
  if (style.bg && style.bg !== 'default') codes.push(colorCode(style.bg, 40));
  return `\x1b[${codes.join(';')}m`;
}

export const spans = (line: Line): Span[] => typeof line === 'string' ? [{ text: line }] : line;
export const plainText = (line: Line): string => spans(line).map(span => span.text).join('');

/**
 * Encodes one row as exactly `width` cells: text is cleaned of controls, cut
 * where the next character would not fit (a wide character never straddles
 * the edge), and the rest is filled with spaces.
 */
export function encodeLine(line: Line, width: number, links = false): string {
  let out = '', used = 0, full = false;
  for (const span of spans(line)) {
    if (full) break;
    const style = span.style ?? {};
    const link = links && style.link ? style.link.replace(/[\x00-\x1f\x7f]/g, '') : '';
    let text = '';
    for (const char of clean(span.text).replace(/\n/g, ' ')) {
      const w = charWidth(char.codePointAt(0)!);
      if (used + w > width) { full = true; break; }
      text += char; used += w;
    }
    if (!text) continue;
    out += sgr(style) + (link ? `\x1b]8;;${link}\x1b\\${text}\x1b]8;;\x1b\\` : text);
  }
  return out + sgr() + ' '.repeat(Math.max(0, width - used));
}

/** Cuts a row to `width` cells, ending in an ellipsis when something was cut. */
export function cutLine(line: Line, width: number): Span[] {
  if (textWidth(plainText(line)) <= width) return spans(line);
  const out: Span[] = [];
  let used = 0;
  for (const span of spans(line)) {
    const w = textWidth(span.text);
    if (used + w <= width - 1) { out.push(span); used += w; continue; }
    let text = '';
    for (const char of span.text) {
      const cw = charWidth(char.codePointAt(0)!);
      if (used + cw > width - 1) break;
      text += char; used += cw;
    }
    if (width > 0) out.push({ text: text + '…', style: span.style });
    break;
  }
  return out;
}

/** Lays out spans left and right on one row: the left side is cut first. */
export function row(left: Line, right: Line, width: number): Span[] {
  const rightWidth = textWidth(plainText(right));
  const leftSpans = cutLine(left, Math.max(0, width - rightWidth - 1));
  const used = textWidth(plainText(leftSpans));
  return [...leftSpans, { text: ' '.repeat(Math.max(0, width - used - rightWidth)) }, ...spans(right)];
}

export interface Output { write(text: string): unknown }

/**
 * Keeps what is on screen and writes only rows that changed. With
 * synchronized output each frame appears at once, so a redraw never flickers.
 */
export class Screen {
  private shown: string[] = [];
  constructor(private readonly out: Output, private readonly options: { sync: boolean; links: boolean }, public width = 80, public height = 24) {}

  resize(width: number, height: number): void {
    this.width = width; this.height = height;
    this.shown = [];
  }

  /** The bytes that draw `lines`, or '' when nothing changed. */
  frame(lines: Line[]): string {
    const rows: string[] = [];
    for (let index = 0; index < this.height; index++) rows.push(encodeLine(lines[index] ?? '', this.width, this.options.links));
    const first = this.shown.length === 0;
    let body = first ? '\x1b[0m\x1b[2J' : '';
    rows.forEach((text, index) => { if (first || this.shown[index] !== text) body += `\x1b[${index + 1};1H${text}`; });
    this.shown = rows;
    if (!body) return '';
    return this.options.sync ? `\x1b[?2026h${body}\x1b[?2026l` : body;
  }

  render(lines: Line[]): void {
    const bytes = this.frame(lines);
    if (bytes) this.out.write(bytes);
  }
}

/** Alternate screen, hidden cursor, SGR mouse, and kitty key disambiguation where supported. */
export const enterBytes = (kittyKeyboard: boolean): string =>
  '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h' + (kittyKeyboard ? '\x1b[>1u' : '');
export const leaveBytes = (kittyKeyboard: boolean): string =>
  (kittyKeyboard ? '\x1b[<u' : '') + '\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l';
