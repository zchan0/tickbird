import { plainText, spans, type Line, type Span } from './screen';
import { charWidth } from './width';

/**
 * Words dragged over with the mouse, as a terminal selects them: from the cell
 * pressed to the cell the pointer is on, running on from line to line. The
 * pane takes the mouse for its clicks, hover and wheel, so it selects for
 * itself: the range is drawn inverted while the button is down, and what it
 * covers is copied on release.
 */
export interface Drag {
  /** 1-based screen cells. */
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** Whether the pointer left the cell it was pressed on: a drag, not a click. */
export const dragged = (drag: Drag): boolean => drag.from.x !== drag.to.x || drag.from.y !== drag.to.y;

/** The range in 0-based rows and cells: the first row from `start`, the last up to `end` (not included). */
function range(drag: Drag): { top: number; bottom: number; start: number; end: number } {
  const [first, last] = drag.from.y < drag.to.y || (drag.from.y === drag.to.y && drag.from.x <= drag.to.x) ? [drag.from, drag.to] : [drag.to, drag.from];
  return { top: first.y - 1, bottom: last.y - 1, start: first.x - 1, end: last.x };
}

/** A row split at a cell: a wide character goes with the side it starts on. */
function split(line: Line, cell: number): [Span[], Span[]] {
  const left: Span[] = [], right: Span[] = [];
  let used = 0;
  for (const span of spans(line)) {
    let before = '', after = '';
    for (const char of span.text) {
      if (used < cell) before += char; else after += char;
      used += charWidth(char.codePointAt(0)!);
    }
    if (before) left.push({ ...span, text: before });
    if (after) right.push({ ...span, text: after });
  }
  return [left, right];
}

/** The cells of row `at` the drag covers, as [from, to). */
function cells(drag: Drag, at: number): [number, number] | undefined {
  const { top, bottom, start, end } = range(drag);
  if (at < top || at > bottom) return undefined;
  return [at === top ? start : 0, at === bottom ? end : Infinity];
}

/** The screen with the dragged range inverted. */
export function markSelection(lines: Line[], drag: Drag): Line[] {
  return lines.map((line, at) => {
    const covered = cells(drag, at);
    if (!covered) return line;
    const [before, rest] = split(line, covered[0]);
    const [inside, after] = covered[1] === Infinity ? [rest, []] : split(rest, covered[1] - covered[0]);
    return [...before, ...inside.map(span => ({ ...span, style: { ...span.style, inverse: true } })), ...after];
  });
}

/**
 * What the drag covers, a line a row: the blank cells at their ends left off,
 * and the page's margin, the indent every row shares; code keeps its own.
 */
export function selectedText(lines: Line[], drag: Drag): string {
  const rows: string[] = [];
  lines.forEach((line, at) => {
    const covered = cells(drag, at);
    if (!covered) return;
    const [, rest] = split(line, covered[0]);
    const [inside] = covered[1] === Infinity ? [rest] : split(rest, covered[1] - covered[0]);
    rows.push(plainText(inside).trimEnd());
  });
  const margin = Math.min(...rows.filter(Boolean).map(text => /^ */.exec(text)![0].length));
  return rows.map(text => text.slice(Number.isFinite(margin) ? margin : 0)).join('\n').replace(/^\n+|\n+$/g, '');
}
