import { highlightedCode } from '../../core/src/highlight';

export { highlightedCode };
const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!));

export function renderCode(text: string, language?: string): string {
  return `<pre class="code-block"><code${language ? ` class="language-${escape(language)}"` : ''}>${highlightedCode(text, language)}</code></pre>`;
}

/** A file as read: a line-number gutter beside the highlighted text, never re-wrapped. */
export function renderFile(lines: string[], start: number | undefined, language?: string): string {
  const gutter = start === undefined ? '' : `<pre class="line-numbers" aria-hidden="true">${lines.map((_, index) => start + index).join('\n')}</pre>`;
  return `<div class="code-surface${gutter ? '' : ' no-gutter'}">${gutter}<pre class="source-code"><code${language ? ` class="language-${escape(language)}"` : ''}>${highlightedCode(lines.join('\n'), language)}</code></pre></div>`;
}
