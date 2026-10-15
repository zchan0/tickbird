/**
 * The fonts Tickbird's views read in, as the agents' own panels do: Claude
 * Code's panel sets its words in `chat.fontSize` / `chat.fontFamily` and its
 * code in `chat.editor.*`. Tickbird sits beside those panels, so it follows
 * the same settings; where one is left at its default, the view falls back to
 * VS Code's own font (the workbench's for words, the editor's for code).
 * Every other size in the views is set relative to these.
 */
export interface FontSettings {
  size?: unknown;
  family?: unknown;
  codeSize?: unknown;
  codeFamily?: unknown;
  codeWeight?: unknown;
}

/** The variables a view reads: --tb-font-size, --tb-font-family, --tb-code-font-size, --tb-code-font-family, --tb-code-font-weight. */
export const FONT_VARIABLES = ['--tb-font-size', '--tb-font-family', '--tb-code-font-size', '--tb-code-font-family', '--tb-code-font-weight'] as const;

const size = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 6 && value <= 64 ? `${value}px` : undefined;

/** A font list as a stylesheet may carry it: no characters that could end the declaration or the rule. */
const family = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const list = value.replace(/[;{}<>\\]/g, '').trim();
  return list && list.toLowerCase() !== 'default' ? list : undefined;
};

const weight = (value: unknown): string | undefined => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^(normal|bold|[1-9]00)$/.test(text) ? text : undefined;
};

export function fontVariables(settings: FontSettings): Record<string, string> {
  const pairs: Array<[string, string | undefined]> = [
    ['--tb-font-size', size(settings.size)],
    ['--tb-font-family', family(settings.family)],
    ['--tb-code-font-size', size(settings.codeSize)],
    ['--tb-code-font-family', family(settings.codeFamily)],
    ['--tb-code-font-weight', weight(settings.codeWeight)],
  ];
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => pair[1] !== undefined));
}

/** The variables as one :root rule's declarations. */
export const fontDeclarations = (variables: Record<string, string>): string =>
  Object.entries(variables).map(([name, value]) => `${name}: ${value};`).join(' ');
