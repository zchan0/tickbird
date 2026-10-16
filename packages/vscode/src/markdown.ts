import MarkdownIt from 'markdown-it';
import { renderCode } from './code';
import { pastedSegments } from '../../core/src/pasted';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
const escape = markdown.utils.escapeHtml;
// Transcript links are references, never commands/navigation. No raw HTML,
// remote images, plugins, script execution or background network requests.
markdown.renderer.rules.link_open = (tokens, index) => `<span class="markdown-link" title="${escape(tokens[index].attrGet('href') ?? '')}">`;
markdown.renderer.rules.link_close = () => '</span>';
markdown.renderer.rules.image = (tokens, index) => `<span class="markdown-image-reference" title="${escape(tokens[index].attrGet('src') ?? '')}">[图片引用：${escape(tokens[index].content || '图像')} · 未加载]</span>`;
markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';
markdown.renderer.rules.fence = (tokens, index) => renderCode(tokens[index].content, tokens[index].info.trim().split(/\s/)[0]);

/** Markdown prose only. Code, command output, JSON and patch use their own readers. */
export function renderMarkdown(text: string): string {
  return `<div class="markdown">${markdown.render(text)}</div>`;
}

/** A request as the user sent it: pasted text and the editor's selection are set apart, their transport tags dropped. */
export function renderUserText(text: string): string {
  const segments = pastedSegments(text);
  if (!segments.some(segment => segment.pasted)) return renderMarkdown(text);
  return `<div class="markdown">${segments.map(segment => segment.pasted
    ? `<div class="pasted"><div class="pasted-label">${escape(segment.label ?? '')}</div>${segment.path === undefined ? renderMarkdown(segment.text) : renderCode(segment.text, /\.([A-Za-z0-9]+)$/.exec(segment.path)?.[1]?.toLowerCase())}</div>`
    : renderMarkdown(segment.text)).join('')}</div>`;
}
