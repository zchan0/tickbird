import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import swift from 'highlight.js/lib/languages/swift';
import diff from 'highlight.js/lib/languages/diff';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import ruby from 'highlight.js/lib/languages/ruby';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini';
for (const [name, grammar] of Object.entries({ bash, javascript, typescript, json, python, swift, diff, css, xml, markdown, yaml, go, rust, java, ruby, sql, ini })) hljs.registerLanguage(name, grammar);
const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!));
export function highlightedCode(text: string, language?: string): string {
  // No auto-detection: stdout remains literal. Bound CPU work, never truncate text.
  if (!language || !hljs.getLanguage(language) || text.length > 128_000) return escape(text);
  try { return hljs.highlight(text, { language, ignoreIllegals: true }).value; } catch { return escape(text); }
}
export function renderCode(text: string, language?: string): string {
  return `<pre class="code-block"><code${language ? ` class="language-${escape(language)}"` : ''}>${highlightedCode(text, language)}</code></pre>`;
}

/** A file as read: a line-number gutter beside the highlighted text, never re-wrapped. */
export function renderFile(lines: string[], start: number | undefined, language?: string): string {
  const gutter = start === undefined ? '' : `<pre class="line-numbers" aria-hidden="true">${lines.map((_, index) => start + index).join('\n')}</pre>`;
  return `<div class="code-surface${gutter ? '' : ' no-gutter'}">${gutter}<pre class="source-code"><code${language ? ` class="language-${escape(language)}"` : ''}>${highlightedCode(lines.join('\n'), language)}</code></pre></div>`;
}
