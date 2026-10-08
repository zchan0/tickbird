import { highlightedCode } from '../../../core/src/highlight';
import type { Color, Span, Style } from '../screen';
import { charWidth, clean } from '../width';

/**
 * Code in palette colours: the same highlight.js grammar as the VS Code panel,
 * its token classes mapped onto the 16 colours so the user's theme decides.
 */
const CLASS_STYLE: Array<[RegExp, Style]> = [
  [/^hljs-(comment|quote)$/, { dim: true, italic: true }],
  [/^hljs-(keyword|selector-tag|built_in|type|doctag)$/, { fg: 'magenta' }],
  [/^hljs-(string|regexp|addition|template-tag|template-variable|symbol|bullet)$/, { fg: 'green' }],
  [/^hljs-(number|literal|variable|params)$/, { fg: 'yellow' }],
  [/^hljs-(title|function|section|name)$/, { fg: 'blue' }],
  [/^hljs-(attr|attribute|property|selector-attr|selector-class|selector-id)$/, { fg: 'cyan' }],
  [/^hljs-(deletion)$/, { fg: 'red' }],
  [/^hljs-(meta|subst|punctuation)$/, { dim: true }],
];

const styleFor = (classes: string): Style => {
  const style: Style = {};
  for (const name of classes.split(/\s+/)) for (const [pattern, add] of CLASS_STYLE) if (pattern.test(name.replace(/_$/, ''))) Object.assign(style, add);
  return style;
};

const entities: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const decode = (text: string) => text.replace(/&(?:lt|gt|amp|quot|#39|#x27);/g, entity => entities[entity]);

/** One array of spans per source line. Unknown languages stay plain. */
export function highlightLines(source: string, language?: string, base: Style = {}): Span[][] {
  // Every line is kept, a last empty one too: callers drop a transport's trailing newline themselves.
  const html = highlightedCode(clean(source), language);
  const lines: Span[][] = [[]];
  const stack: Style[] = [base];
  // highlight.js emits only <span class="…">, </span> and escaped text; spans may cross lines.
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (!part) continue;
    const open = /^<span class="([^"]*)">$/.exec(part);
    if (open) { stack.push({ ...stack[stack.length - 1], ...styleFor(open[1]) }); continue; }
    if (part === '</span>') { if (stack.length > 1) stack.pop(); continue; }
    decode(part).split('\n').forEach((text, index) => {
      if (index) lines.push([]);
      if (text) lines[lines.length - 1].push({ text, style: stack[stack.length - 1] });
    });
  }
  return lines;
}

/** Hard-wraps one code line at `width` cells, anywhere: code has no word rules. */
export function hardWrap(spans: Span[], width: number): Span[][] {
  const lines: Span[][] = [[]];
  let used = 0;
  for (const span of spans) {
    let text = '';
    for (const char of span.text) {
      const w = charWidth(char.codePointAt(0)!);
      if (used + w > width && used > 0) {
        if (text) lines[lines.length - 1].push({ text, style: span.style });
        lines.push([]); text = ''; used = 0;
      }
      text += char; used += w;
    }
    if (text) lines[lines.length - 1].push({ text, style: span.style });
  }
  return lines;
}

export const DIFF_COLORS: Record<'+' | '-', Color> = { '+': 'green', '-': 'red' };
