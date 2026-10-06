import MarkdownIt from 'markdown-it';
import { charWidth, clean, textWidth, wrap } from '../width';
import type { Span, Style } from '../screen';

/**
 * The agent's words as screen lines. Markdown is parsed the way the VS Code
 * panel parses it (markdown-it, no HTML, a line break is a break), then laid
 * out in cells: tables get borders and wrap inside their cells, code keeps its
 * lines, links show their text and their address but never become clickable,
 * the same rule as the panel's.
 */
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
type Token = ReturnType<MarkdownIt['parse']>[number];

/** Draws a symbol, or its ASCII stand-in where the terminal does not draw it one cell wide. */
export type Glyph = (ch: string) => string;

export interface ProseOptions {
  /** Text style, e.g. dim italic for text not yet in the transcript. */
  style?: Style;
  /** Cells of left margin on every line. */
  indent: number;
  /** Replaces the margin on the first line (e.g. ` ● `); must be `indent` cells wide. */
  lead?: Span[];
  glyph?: Glyph;
}

type Line = Span[];
interface Node { token: Token; children: Node[] }

/** markdown-it's flat stream as a tree: an open token holds everything up to its close. */
function tree(tokens: Token[]): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const token of tokens) {
    if (token.nesting === -1) { stack.pop(); continue; }
    const node: Node = { token, children: [] };
    stack[stack.length - 1].push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return root;
}

const DIM: Style = { dim: true };
const merge = (base: Style, extra: Style): Style => ({ ...base, ...extra });

/** Inline content as spans, one array per source line (a line break starts a new one). */
function inlineSegments(children: Token[] | null | undefined, base: Style): Line[] {
  const lines: Line[] = [[]];
  const styles: Style[] = [base];
  const top = () => styles[styles.length - 1];
  const push = (text: string, style = top()) => { if (text) lines[lines.length - 1].push({ text, style }); };
  const links: Array<{ href: string; from: number }> = [];
  const shownSince = (from: number) => lines[lines.length - 1].slice(from).map(span => span.text).join('');
  for (const child of children ?? []) {
    switch (child.type) {
      case 'text': push(child.content); break;
      case 'code_inline': push(child.content, merge(top(), { fg: 'cyan' })); break;
      case 'strong_open': styles.push(merge(top(), { bold: true })); break;
      case 'em_open': styles.push(merge(top(), { italic: true })); break;
      case 's_open': styles.push(merge(top(), { strike: true })); break;
      case 'link_open':
        links.push({ href: child.attrGet('href') ?? '', from: lines[lines.length - 1].length });
        styles.push(merge(top(), { underline: true }));
        break;
      case 'link_close': {
        styles.pop();
        const link = links.pop();
        // Where it points, unless the text already says so.
        if (link?.href && shownSince(link.from) !== link.href) push(` (${link.href})`, merge(top(), DIM));
        break;
      }
      case 'strong_close': case 'em_close': case 's_close': styles.pop(); break;
      case 'image': push(`[图片引用：${child.content || '图像'} · 未加载]`, merge(top(), DIM)); break;
      case 'softbreak': case 'hardbreak': lines.push([]); break;
      default: push(child.content);
    }
  }
  return lines;
}

/**
 * Wraps styled spans to `width` cells with the same rules as plain text, then
 * puts each character's style back. Wrapping only drops spaces at the breaks
 * and keeps order, so each wrapped line is found in the source in turn.
 */
export function wrapSpans(spans: Span[], width: number): Line[] {
  const text = spans.map(span => span.text).join('');
  const styles: Array<Style | undefined> = [];
  for (const span of spans) for (let i = 0; i < span.text.length; i++) styles.push(span.style);
  const lines: Line[] = [];
  let cursor = 0;
  for (const line of wrap(text, width)) {
    const at = line ? text.indexOf(line, cursor) : cursor;
    const start = at < 0 ? cursor : at;
    const out: Line = [];
    for (let i = 0; i < line.length; i++) {
      const style = styles[start + i];
      const previous = out.at(-1);
      if (previous && previous.style === style) previous.text += line[i];
      else out.push({ text: line[i], ...(style ? { style } : {}) });
    }
    lines.push(out);
    cursor = start + line.length;
  }
  return lines;
}

const inlineLines = (token: Token | undefined, width: number, base: Style): Line[] =>
  inlineSegments(token?.children, base).flatMap(segment => segment.length ? wrapSpans(segment, width) : [[]]);

/** Cuts a code line to `width` cells; a dim ellipsis in the last cell says something was cut. */
function cut(spans: Line, width: number, glyph: Glyph): Line {
  if (lineWidth(spans) <= width) return spans;
  const out: Line = [];
  let used = 0;
  for (const span of spans) {
    let text = '';
    for (const char of span.text) {
      const w = charWidth(char.codePointAt(0)!);
      if (used + w > width - 1) { if (text) out.push({ text, style: span.style }); out.push({ text: glyph('…') === '…' ? '…' : '>', style: DIM }); return out; }
      text += char; used += w;
    }
    out.push({ text, style: span.style });
  }
  return out;
}

const lineWidth = (line: Line) => textWidth(line.map(span => span.text).join(''));
const prefix = (lines: Line[], first: Line, rest: Line): Line[] => lines.map((line, index) => [...(index ? rest : first), ...line]);

interface Context { base: Style; glyph: Glyph }

/** Blocks one blank line apart; a tight list's items stay together. */
function blocks(nodes: Node[], width: number, ctx: Context, tight = false): Line[] {
  const parts = nodes.map(node => block(node, width, ctx)).filter(part => part.length);
  return parts.flatMap((part, index) => index && !tight ? [[], ...part] : part);
}

function block(node: Node, width: number, ctx: Context): Line[] {
  const { token } = node;
  switch (token.type) {
    case 'paragraph_open': return inlineLines(node.children[0]?.token, width, ctx.base);
    case 'inline': return inlineLines(token, width, ctx.base);
    case 'heading_open': {
      // Weight is the only level: every heading bold, the top two also underlined.
      const level = Number(token.tag.slice(1));
      return inlineLines(node.children[0]?.token, width, merge(ctx.base, { bold: true, ...(level <= 2 ? { underline: true } : {}) }));
    }
    case 'bullet_list_open': case 'ordered_list_open': return list(node, width, ctx);
    case 'blockquote_open': {
      const bar: Line = [{ text: ctx.glyph('│') + ' ', style: merge(ctx.base, DIM) }];
      return prefix(blocks(node.children, Math.max(4, width - 2), ctx), bar, bar);
    }
    case 'fence': case 'code_block': {
      const code = clean(token.content).replace(/\n$/, '').split('\n');
      return code.map(text => cut([{ text: '  ' + text, style: merge(ctx.base, { fg: 'cyan' }) }], width, ctx.glyph));
    }
    case 'hr': return [[{ text: ctx.glyph('─').repeat(Math.max(1, Math.min(width, 40))), style: merge(ctx.base, DIM) }]];
    case 'table_open': return table(node, width, ctx);
    default:
      if (node.children.length) return blocks(node.children, width, ctx);
      return token.content ? wrapSpans([{ text: token.content, style: ctx.base }], width) : [];
  }
}

function list(node: Node, width: number, ctx: Context): Line[] {
  const ordered = node.token.type === 'ordered_list_open';
  const start = Number(node.token.attrGet('start') ?? 1);
  const items = node.children.filter(child => child.token.type === 'list_item_open');
  const markers = items.map((_, index) => ordered ? `${start + index}. ` : '- ');
  const markerWidth = Math.max(...markers.map(marker => textWidth(marker)));
  // markdown-it hides the paragraphs of a tight list.
  const tight = items.every(item => item.children.every(child => child.token.type !== 'paragraph_open' || child.token.hidden));
  const out: Line[] = [];
  items.forEach((item, index) => {
    let marker = markers[index].padStart(markerWidth);
    let markerStyle = merge(ctx.base, DIM);
    // A task item: "[ ] " or "[x] " at the start of its first line.
    const inline = item.children[0]?.children[0]?.token;
    const first = inline?.children?.[0];
    const task = !ordered && first?.type === 'text' ? first.content.match(/^\[([ xX])\]\s+/) : null;
    if (task && first) {
      first.content = first.content.slice(task[0].length);
      marker = ctx.glyph(task[1] === ' ' ? '☐' : '☑') + ' ';
      if (task[1] !== ' ') markerStyle = ctx.base;
    }
    const hang = Math.max(markerWidth, textWidth(marker));
    const body = blocks(item.children, Math.max(4, width - hang), ctx, tight);
    if (index && !tight) out.push([]);
    out.push(...prefix(body.length ? body : [[]], [{ text: marker.padEnd(hang), style: markerStyle }], [{ text: ' '.repeat(hang) }]));
  });
  return out;
}

/** Fits columns into `room` cells: narrow columns keep their width, the rest share what is left. */
export function columnWidths(natural: number[], room: number, least = 4): number[] | undefined {
  if (natural.reduce((sum, w) => sum + w, 0) <= room) return natural;
  if (natural.length * least > room) return undefined;
  const widths = natural.slice();
  const order = natural.map((w, index) => ({ w, index })).sort((a, b) => a.w - b.w);
  let left = room;
  order.forEach(({ w, index }, position) => {
    const share = Math.floor(left / (order.length - position));
    widths[index] = Math.max(Math.min(least, w), Math.min(w, share));
    left -= widths[index];
  });
  return widths;
}

interface Cell { lines: Line[]; align: 'left' | 'right' | 'center' }
interface Row { header: boolean; cells: Cell[] }

/**
 * A table with borders, as Claude Code draws them. Too wide, its cells wrap;
 * too narrow even for that, each row becomes a record of "header / value" lines.
 */
function table(node: Node, width: number, ctx: Context): Line[] {
  const rows: Row[] = [];
  const visit = (nodes: Node[], header: boolean) => {
    for (const child of nodes) {
      if (child.token.type === 'thead_open') visit(child.children, true);
      else if (child.token.type === 'tbody_open') visit(child.children, false);
      else if (child.token.type === 'tr_open') rows.push({ header, cells: child.children.map(cell => {
        const style = cell.token.attrGet('style') ?? '';
        return {
          lines: inlineSegments(cell.children[0]?.token.children, merge(ctx.base, header ? { bold: true } : {})),
          align: /right/.test(style) ? 'right' : /center/.test(style) ? 'center' : 'left',
        };
      }) });
    }
  };
  visit(node.children, false);
  if (!rows.length) return [];
  const count = Math.max(...rows.map(row => row.cells.length));
  const natural = Array.from({ length: count }, (_, column) => Math.max(1, ...rows.map(row => Math.max(0, ...(row.cells[column]?.lines ?? []).map(lineWidth)))));
  // Borders: one per column plus one, and a space each side of every cell.
  const widths = columnWidths(natural, width - (count + 1) - 2 * count);
  if (!widths) return records(rows, width, ctx);
  const g = ctx.glyph, border = merge(ctx.base, DIM);
  const rule = (left: string, middle: string, right: string): Line =>
    [{ text: g(left) + widths.map(w => g('─').repeat(w + 2)).join(g(middle)) + g(right), style: border }];
  const out: Line[] = [rule('┌', '┬', '┐')];
  rows.forEach((row, index) => {
    const cells = widths.map((w, column) => (row.cells[column]?.lines ?? [[]]).flatMap(line => line.length ? wrapSpans(line, w) : [[]]));
    const height = Math.max(...cells.map(cell => cell.length));
    for (let line = 0; line < height; line++) {
      const spans: Line = [{ text: g('│'), style: border }];
      cells.forEach((cell, column) => {
        const content = cell[line] ?? [];
        const gap = widths[column] - lineWidth(content);
        const align = row.cells[column]?.align ?? 'left';
        const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0;
        spans.push({ text: ' '.repeat(before + 1) }, ...content, { text: ' '.repeat(gap - before + 1) }, { text: g('│'), style: border });
      });
      out.push(spans);
    }
    if (row.header && !rows[index + 1]?.header) out.push(rule('├', '┼', '┤'));
  });
  out.push(rule('└', '┴', '┘'));
  return out;
}

function records(rows: Row[], width: number, ctx: Context): Line[] {
  const headers = rows.filter(row => row.header).at(-1)?.cells.map(cell => cell.lines.flat().map(span => span.text).join('')) ?? [];
  const out: Line[] = [];
  for (const row of rows.filter(row => !row.header)) {
    if (out.length) out.push([]);
    row.cells.forEach((cell, column) => {
      if (headers[column]) out.push(...wrapSpans([{ text: headers[column], style: merge(ctx.base, DIM) }], width));
      const value = cell.lines.flatMap((line, index) => index ? [{ text: ' ' }, ...line] : line);
      out.push(...prefix(wrapSpans(value.length ? value : [{ text: '' }], Math.max(4, width - 2)), [{ text: '  ' }], [{ text: '  ' }]));
    });
  }
  return out;
}

/** The agent's words, laid out to `width` cells with `indent` cells of margin. */
export function prose(source: string, width: number, options: ProseOptions): Line[] {
  const ctx: Context = { base: options.style ?? {}, glyph: options.glyph ?? (ch => ch) };
  const margin: Line = [{ text: ' '.repeat(options.indent) }];
  const room = Math.max(4, width - options.indent);
  const out = blocks(tree(markdown.parse(clean(source), {})), room, ctx).map(line => line.length ? [...margin, ...line] : []);
  if (options.lead && out.length) out[0] = [...options.lead, ...out[0].slice(1)];
  return out;
}

/** Inline Markdown of one line as spans. */
export const inlineSpans = (text: string, base: Style = {}): Span[] =>
  inlineSegments(markdown.parseInline(clean(text), {})[0]?.children, base).flatMap((line, index) => index ? [{ text: ' ', style: base }, ...line] : line);
