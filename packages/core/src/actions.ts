import ts from 'typescript';
import type { TimelineItem } from './model';

/** Labels describe recorded inputs, never inferred execution or inner-call success. */
export interface ActionEntry { label: string; key: string; targets?: string[]; count: number; toolName?: string; displayType?: ActionType }
export interface ActionDescription {
  label: string;
  key: string;
  targets?: string[];
  entries: ActionEntry[];
  unresolved?: boolean;
}
export type ActionType = 'BASH' | 'READ' | 'SKILL' | 'WEB' | 'SEARCH' | 'TEST' | 'BUILD' | 'EDIT' | 'WRITE' | 'FILE' | 'AGENT' | 'ASK' | 'IMAGE' | 'GIT' | 'INSTALL' | 'WAIT' | 'UNKNOWN' | 'TOOL';
export interface ActionPresentation { type: ActionType; label: string }
type Obj = Record<string, unknown>;
type Atom = Omit<ActionEntry, 'count'>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const compact = (value: string, limit = 64): string => {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const basename = (value: string): string => value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || value;
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
const atom = (kind: string, label: string, targets: string[] = []): Atom => ({
  label: targets.length ? `${label} · ${targets.slice(0, 2).map(value => compact(value)).join('、')}${targets.length > 2 ? ` 等 ${targets.length} 项` : ''}` : label,
  key: JSON.stringify([kind, targets]), ...(targets.length ? { targets } : {}),
});
const fileAtom = (kind: string, label: string, targets: string[]): Atom => {
  const value = atom(kind, label, targets);
  return { ...value, label: targets.length ? `${label} · ${targets.slice(0, 2).map(value => compact(basename(value))).join('、')}${targets.length > 2 ? ` 等 ${targets.length} 个文件` : ''}` : label };
};
const searchAtom = (label: string, pattern: string, paths: string[], identity?: unknown): Atom => {
  const targets = [pattern, ...paths].filter(Boolean);
  const visible = [compact(pattern, 32), ...paths.slice(0, 1).map(value => compact(basename(value), 32))].filter(Boolean);
  return { ...atom('search:files', label, targets), label: `${label}${visible.length ? ` · ${visible.join(' · ')}` : ''}`, ...(identity === undefined ? {} : { key: JSON.stringify(['search:files', identity]) }) };
};
const webQuery = (query: string): string => compact(query.replace(/(?:^|\s)site:\S+/g, ' ').trim() || query, 40);
const webSource = (reference: string): string => {
  // Internal references are identity, not a useful page title. Never resolve URLs.
  if (!/^https?:\/\//i.test(reference)) return '';
  try { return compact(new URL(reference).hostname, 40); } catch { return ''; }
};
const unresolved = (): Atom => atom('orchestration:unresolved', '编排调用（未解析）');
const normalized = (name: string): string => name.replace(/^functions[/.]/, '').replace(/\//g, '__');

/** Only literal data is decoded. Identifiers, spreads, getters and substitutions are not evaluated. */
function literal(node: ts.Expression | undefined): unknown {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(value => ts.isSpreadElement(value) ? undefined : literal(value));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Obj = Object.create(null) as Obj;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return undefined;
      const key = property.name.text;
      // A later dynamic spread could replace any earlier value. Do not guess.
      if (node.properties.some(ts.isSpreadAssignment)) return undefined;
      result[key] = literal(property.initializer);
    }
    return result;
  }
  return undefined;
}
function referencesTools(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'tools') return true;
  return !!ts.forEachChild(node, child => referencesTools(child) || undefined);
}
function shadowsTools(node: ts.Node): boolean {
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && referencesTools(node.name)) return true;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && referencesTools(node.left)) return true;
  return !!ts.forEachChild(node, child => shadowsTools(child) || undefined);
}

/** A syntax hint, never an evaluated command or proof a conditional call ran. */
export function execCommandHint(source: string): string | undefined {
  if (source.length > 256_000) return undefined;
  const tree = ts.createSourceFile('recorded-input.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length || shadowsTools(tree)) return undefined;
  const hints: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'tools'
      && node.expression.name.text === 'exec_command') {
      const args = node.arguments[0];
      if (args && ts.isObjectLiteralExpression(args) && !args.properties.some(ts.isSpreadAssignment)) {
        const property = args.properties.find(p => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && ['cmd', 'command'].includes(p.name.text));
        if (property && ts.isPropertyAssignment(property)) {
          const value = literal(property.initializer);
          hints.push(typeof value === 'string' ? compact(value, 120) : `cmd: ${compact(property.initializer.getText(tree), 120)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return hints.length ? hints.slice(0, 3).map(hint => `[${hint}]`).join(' ') : undefined;
}

/** Traverse only eager, non-conditional expressions in top-level statements. */
function wrapperActions(source: string, decode = toolActions): Atom[] {
  if (!source.trim() || source.length > 256_000) return [unresolved()];
  const tree = ts.createSourceFile('recorded-input.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length || shadowsTools(tree)) return [unresolved()];
  const result: Atom[] = [];
  const unknown = (): void => { result.push(unresolved()); };
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (referencesTools(node)) unknown();
      return;
    }
    if (ts.isConditionalExpression(node) || ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isWithStatement(node) || ts.isThrowStatement(node) || ts.isReturnStatement(node)) {
      if (referencesTools(node)) unknown();
      return;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      visit(node.left);
      if (referencesTools(node.right)) unknown();
      return;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && ts.isIdentifier(expression.expression) && expression.expression.text === 'tools') {
        const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : literal(expression.argumentExpression);
        if (typeof name !== 'string' || node.questionDotToken || expression.questionDotToken) { unknown(); return; }
        // Evaluate argument calls before the outer call, matching source evaluation order.
        node.arguments.forEach(visit);
        result.push(...decode(name, literal(node.arguments[0])));
        return;
      }
      if (node.questionDotToken) { if (referencesTools(node)) unknown(); return; }
    }
    ts.forEachChild(node, visit);
  };
  tree.statements.forEach(visit);
  return result.length ? result : [unresolved()];
}

/** Static literal call inputs only. No evaluation, result pairing or execution claim. */
export function recordedToolInputs(item: TimelineItem): Array<{ name: string; input: unknown }> {
  const block = item.detail?.blocks.find(block => ['记录中的调用参数', '当时调用参数', '当时命令'].includes(block.label) && ['code', 'json'].includes(block.kind));
  if (!block?.text) return [];
  if (block.label === '当时命令') return [{ name: 'exec_command', input: { cmd: block.text } }];
  let input: unknown = block.text;
  try { input = JSON.parse(block.text); } catch { /* Custom tool input. */ }
  const name = normalized(item.title);
  if (!['exec', 'functions__exec'].includes(name)) return [{ name, input }];
  if (typeof input !== 'string') return [{ name: 'exec', input }];
  const calls: Array<{ name: string; input: unknown }> = [];
  const atoms = wrapperActions(input, (name, input) => {
    calls.push({ name: normalized(name), input });
    return [atom('recorded-call', name)];
  });
  // If any part is opaque, show the actual enclosing input instead of pretending
  // a partial static expansion is the whole call.
  const complete = (value: unknown): boolean => value !== undefined && (Array.isArray(value) ? value.every(complete) : value !== null && typeof value === 'object' ? Object.values(value).every(complete) : true);
  return atoms.some(entry => entry.label === '编排调用（未解析）') || calls.some(call => !complete(call.input)) ? [{ name: 'exec', input }] : calls;
}

interface ShellToken { text: string; operator?: boolean; dynamic?: boolean }
/** A bounded lexer, not a shell interpreter. Quoted command-looking text stays an argument. */
function shellTokens(command: string): ShellToken[] | undefined {
  if (command.length > 64_000) return undefined;
  const result: ShellToken[] = [];
  let value = ''; let quote = ''; let active = false; let dynamic = false;
  const flush = (): void => { if (active) result.push({ text: value, ...(dynamic ? { dynamic: true } : {}) }); value = ''; active = false; dynamic = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; else value += c; continue; }
    if (c === '\\') { if (i + 1 >= command.length) return undefined; value += command[++i]; active = true; continue; }
    if (quote === '"') { if (c === '"') quote = ''; else { value += c; if (c === '$' || c === '`') dynamic = true; } continue; }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (/\s/.test(c)) { flush(); if (c === '\n') result.push({ text: ';', operator: true }); continue; }
    if (c === '#' && !active) { while (i < command.length && command[i] !== '\n') i++; flush(); result.push({ text: ';', operator: true }); continue; }
    if (';&|<>()'.includes(c)) {
      flush(); const next = command[i + 1]; const op = (c === '&' || c === '|') && next === c ? c + command[++i] : c;
      result.push({ text: op, operator: true }); continue;
    }
    active = true; value += c; if (c === '$' || c === '`') dynamic = true;
  }
  if (quote) return undefined;
  flush(); return result;
}
export function skillPath(path: string): string | undefined {
  const match = /(?:^|\/)skills\/(?:[^/]+\/)*([^/]+)\/SKILL\.md$/.exec(path.replace(/\\/g, '/'));
  return match?.[1];
}
function readActions(paths: string[]): Atom[] {
  const entries: Atom[] = []; const normal: string[] = [];
  for (const path of paths) {
    const skill = skillPath(path);
    if (skill) entries.push({ ...atom('skill:read', `Skill · ${compact(skill)}`, []), key: JSON.stringify(['skill:read', path]), targets: [path] });
    else normal.push(path);
  }
  if (normal.length || !entries.length) entries.push(fileAtom('read', '读取', normal));
  return entries;
}

/** `cd <literal dir> && <rest>`: the directory only resolves the rest's relative paths. */
function withoutCd(tokens: ShellToken[]): { dir?: string; tokens: ShellToken[] } {
  const [cd, dir, and] = tokens;
  return tokens.length > 3 && cd.text === 'cd' && !cd.operator && !dir.operator && !dir.dynamic && and.operator && and.text === '&&'
    ? { dir: dir.text, tokens: tokens.slice(3) } : { tokens };
}
const inDirectory = (dir: string | undefined, path: string): string => !dir || path.startsWith('/') ? path : `${dir.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`;

/** A single literal, read-only shell expression. No pipes, redirects or branches. */
export function shellReadTargets(command: string): string[] | undefined {
  const all = shellTokens(command);
  if (!all?.length) return undefined;
  const { dir, tokens } = withoutCd(all);
  if (tokens.some(token => token.operator || token.dynamic)) return undefined;
  const name = basename(tokens[0].text), args = tokens.slice(1);
  if (!['cat', 'head', 'tail', 'sed'].includes(name)) return undefined;
  // Unknown options may have side effects (for example sed --in-place).
  const allowed = name === 'cat' ? /^-(?:[benstuvAET]+|-show-all|-number|-number-nonblank|-squeeze-blank)$/
    : name === 'sed' ? /^-(?:n|e)$/ : /^-(?:[ncvq]|\d+)$/;
  if (args.some(token => token.text.startsWith('-') && token.text !== '--' && !allowed.test(token.text))) return undefined;
  const actions = shellSegment(tokens);
  if (!actions.length || actions.some(action => !['read', 'skill:read'].includes(JSON.parse(action.key)[0]))) return undefined;
  const paths = actions.flatMap(action => action.targets ?? []);
  return paths.length && paths.every(path => path !== '-' && !/[?*\[\]]/.test(path)) ? paths.map(path => inDirectory(dir, path)) : undefined;
}

/** One file read by a shell command, and the line it starts at when its own arguments say so. */
export function shellReadRange(command: string): { path: string; start?: number } | undefined {
  const paths = shellReadTargets(command);
  if (paths?.length !== 1) return undefined;
  const tokens = withoutCd(shellTokens(command)!).tokens, name = basename(tokens[0].text);
  if (name === 'cat' || name === 'head') return { path: paths[0], start: 1 };
  const range = name === 'sed' ? tokens.slice(1).map(token => /^(\d+)(?:,\d+)?p$/.exec(token.text)).find(Boolean) : undefined;
  // tail, or a sed script that is not one plain range: where it starts is unknown.
  return { path: paths[0], ...(range ? { start: Number(range[1]) } : {}) };
}
function positional(args: ShellToken[], consumes: Set<string>): string[] {
  const result: string[] = []; let options = true;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.dynamic) continue;
    if (options && token.text === '--') { options = false; continue; }
    if (options && consumes.has(token.text)) { i++; continue; }
    if (options && token.text.startsWith('-')) continue;
    result.push(token.text);
  }
  return result;
}
function shellSegment(tokens: ShellToken[]): Atom[] {
  const command = tokens[0]?.text || '';
  const name = basename(command); const args = tokens.slice(1); const words = args.map(value => value.text);
  if (!command || tokens[0].dynamic) return [atom('command:dynamic', '命令（动态参数）')];
  if (name === 'cat') return readActions(positional(args, new Set()));
  if (name === 'head' || name === 'tail') return readActions(positional(args, new Set(['-n', '-c', '--lines', '--bytes'])));
  if (name === 'sed') {
    if (words.some(value => value === '-i' || value.startsWith('-i') || value.startsWith('--in-place'))) return [atom('command:sed', '命令 · sed')];
    const targets = positional(args, new Set(['-e', '--expression', '-f', '--file']));
    const expressionIndex = words.includes('-e') ? words.indexOf('-e') : words.indexOf('--expression');
    const expression = expressionIndex >= 0 ? words[expressionIndex + 1] : targets[0];
    // sed is also capable of writing files or invoking commands. Only the plain
    // line-range print form observed in source records earns a read label.
    if (!expression || !/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(expression) || words.includes('-f') || words.includes('--file') || words.filter(value => value === '-e' || value === '--expression').length > 1) return [atom('command:sed', '命令 · sed')];
    return readActions(expressionIndex >= 0 ? targets : targets.slice(1));
  }
  if (name === 'rg' || name === 'grep') {
    const targets = positional(args, new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '--context', '-m', '--max-count', '-e', '--regexp', '-f', '--file', '--max-depth']));
    const patternIndex = words.findIndex(value => value === '-e' || value === '--regexp');
    if (words.includes('--files')) {
      const includes = words.flatMap((word, index) => ['-g', '--glob'].includes(word) && words[index + 1] && !words[index + 1].startsWith('!') ? [words[index + 1]] : []);
      return [searchAtom('查找文件', includes.join('、'), targets, [name, ...words])];
    }
    return [searchAtom('搜索代码', patternIndex >= 0 ? words[patternIndex + 1] : targets[0] || '', patternIndex >= 0 ? targets : targets.slice(1), [name, ...words])];
  }
  if (name === 'ls' || name === 'find') return [fileAtom('list', '查看目录', positional(args, new Set(['-maxdepth', '-mindepth', '-name', '-iname', '-type'])) )];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const action = words[0] === 'run' ? words[1] : words[0];
    if (action && /^(?:test|check|lint|verify)(?::|$)/.test(action)) return [atom('test', '验证', [`${name} ${words.filter(value => value !== '--').join(' ')}`])];
    if (action && /^(?:build|compile)(?::|$)/.test(action)) return [atom('build', '构建', [`${name} ${words.join(' ')}`])];
    if (action === 'install' || action === 'ci' || action === 'add') return [atom('dependencies', '安装依赖', [name])];
  }
  if (['pytest', 'jest', 'vitest'].includes(name) || (name === 'node' && words.includes('--test')) || (['cargo', 'go', 'swift'].includes(name) && words[0] === 'test')) return [atom('test', '测试', [compact([name, ...words].join(' '), 120)])];
  if (name === 'tsc') return [atom(words.includes('--noEmit') ? 'test' : 'build', words.includes('--noEmit') ? '检查类型' : '构建', [compact([name, ...words].join(' '), 120)])];
  if (name === 'git') {
    const commandIndex = words[0] === '-C' ? 2 : 0; const gitAction = words[commandIndex];
    if (['diff', 'status', 'log', 'show'].includes(gitAction)) return [atom(`git:${gitAction}`, ({ diff: '查看改动', status: '检查工作区', log: '查看提交', show: '查看版本' } as Record<string, string>)[gitAction], words.slice(commandIndex + 1).filter(value => !value.startsWith('-')))];
  }
  const script = ['node', 'python', 'python3', 'ruby'].includes(name) && words[0] && !words[0].startsWith('-') ? ` · ${compact(basename(words[0]), 32)}` : '';
  return [{ ...atom(`command:${name}`, '', [tokens.map(value => value.text).join(' ')]), label: `命令 · ${compact(name, 32)}${script}` }];
}

/** Unwrap only an exact shell argv shape; argument boundaries are evidence. */
export function shellArgvScript(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(part => typeof part === 'string')) return undefined;
  return ['sh', 'bash', 'zsh'].includes(basename(value[0])) && /^-(?:c|lc|cl)$/.test(value[1]) ? value[2] : undefined;
}

function summaryOperations(command: string, depth = 0): Atom[] {
  const tokens = shellTokens(command);
  if (!tokens?.length || depth > 3) return commandActions(command);
  const script = !tokens.some(token => token.operator || token.dynamic) ? shellArgvScript(tokens.map(token => token.text)) : undefined;
  if (script !== undefined) return summaryOperations(script, depth + 1);
  // Only split simple, literal pipelines and sequential syntax. Expansions,
  // redirects, assignments and control flow stay opaque, as in the raw reader.
  if (tokens.some(token => token.dynamic || token.operator && ![';', '&&', '|'].includes(token.text))
    || tokens.some((token, index) => (index === 0 || tokens[index - 1].operator) && (['if', 'for', 'while', 'until', 'case', 'function', 'then', 'elif', 'else', 'do', '!'].includes(token.text) || /^\w+=/.test(token.text)))) return commandActions(command);
  const operations: Atom[] = []; let segment: ShellToken[] = []; let piped = false;
  for (const token of [...tokens, { text: ';', operator: true }]) {
    if (!token.operator) { segment.push(token); continue; }
    if (segment.length) {
      const name = basename(segment[0].text), words = segment.slice(1).map(part => part.text);
      const limiter = piped && ['head', 'tail'].includes(name) && /^-(?:n\s+)?\d+$/.test(words.join(' '));
      const nested = shellArgvScript(segment.map(part => part.text));
      if (limiter) operations.push(atom('pipe:limit', `取${name === 'head' ? '前' : '后'} ${words.join(' ').match(/\d+/)![0]} 行`));
      else if (nested !== undefined) operations.push(...summaryOperations(nested, depth + 1));
      else {
        const actions = shellSegment(segment);
        operations.push(...actions.map(action => JSON.parse(action.key)[0].startsWith('command:')
          ? { ...action, label: ['echo', 'printf'].includes(name) ? `输出文本 · ${compact(words.join(' '), 64)}` : compact([name, ...words].join(' '), 80) } : action));
      }
    }
    segment = []; piped = token.text === '|';
  }
  return operations;
}

/** A bounded summary of shell syntax. Never executes commands or claims success. */
export function summarizeShell(command: string): string {
  const firstLine = command.trim().split(/\r?\n/)[0] ?? '';
  const header = shellTokens(firstLine);
  const heredoc = header?.some((token, index) => token.operator && token.text === '<' && header[index + 1]?.operator && header[index + 1].text === '<');
  // Heredoc bodies are another language or literal data, not shell tokens.
  // If the lexer cannot establish boundaries, keep a useful source excerpt.
  if (heredoc || !shellTokens(command)) {
    return /^(?:python3?|node|ruby)\b/.test(firstLine) ? `运行 ${firstLine.split(/\s/)[0]} 脚本` : compact(firstLine, 96) || '参数未记录';
  }
  const operations = summaryOperations(command);
  const labels: string[] = [];
  let readPaths: string[] = [];
  const flushReads = () => { if (readPaths.length) labels.push('读取 ' + unique(readPaths).map(basename).join(' / ')); readPaths = []; };
  for (const operation of operations) {
    const kind = JSON.parse(operation.key)[0] as string;
    if (operations.length > 1 && ['command:pwd', 'command:echo', 'command:printf'].includes(kind)) continue;
    if (kind === 'read' && operation.targets?.length) { readPaths.push(...operation.targets); continue; }
    flushReads();
    let label = operation.label.replace(/^命令 · /, '').replace(/^命令（/, '脚本（');
    if (kind === 'git:status') label = '检查 Git 状态';
    if (kind === 'search:files' && operation.targets?.slice(1).some(path => /(?:^|\/)(?:MEMORY|memory_summary)\.md$/.test(path))) label = '检索项目记忆';
    if (kind === 'search:files' && operation.label.startsWith('查找文件') && /(?:AGENTS|CLAUDE)\.md/.test(operation.targets?.[0] ?? '')) label = '查找项目规范';
    if (kind === 'command:complex') {
      const source = operation.targets?.[0]?.trim() || command.trim();
      label = /^(?:python3?|node|ruby)\b/.test(source) ? '运行 ' + source.split(/\s/)[0] + ' 脚本'
        : compact(source, 96) + (shellTokens(source)?.some(token => token.dynamic) ? '（动态参数）' : '');
    }
    if (!labels.includes(label)) labels.push(label);
  }
  flushReads();
  return labels.slice(0, 4).join('；') + (labels.length > 4 ? `；另 ${labels.length - 4} 项` : '');
}
function commandActions(command: string): Atom[] {
  const tokens = shellTokens(command);
  if (!tokens || !tokens.length) return [atom('command:unparsed', '命令（未解析）')];
  // Do not interpret pipelines, substitutions, redirections, compound shell syntax,
  // assignments, or conditional branches as independent successful actions.
  const compound = tokens.some((token, index) => (index === 0 || tokens[index - 1].operator) && (['if', 'for', 'while', 'until', 'case', 'function', 'then', 'elif', 'else', 'do', '!'].includes(token.text) || /^\w+=/.test(token.text)));
  if (tokens.some(token => token.dynamic || token.operator && ![';', '&&'].includes(token.text)) || compound) {
    const first = tokens[0]; const name = first.dynamic || compound ? '' : basename(first.text);
    const purePipeline = !tokens.some(token => token.dynamic || token.operator && token.text !== '|') && tokens.some(token => token.text === '|');
    const purpose = purePipeline && ['rg', 'grep'].includes(name) ? '搜索代码' : purePipeline && ['cat', 'head', 'tail', 'nl'].includes(name) ? '读取文件' : '';
    const suffix = tokens.some(token => token.text === '|') ? '（含管道）' : tokens.some(token => token.dynamic) ? '（动态参数）' : '（复合命令）';
    return [{ ...atom('command:complex', '', [command]), label: purpose ? `${purpose}${suffix}` : `命令${name ? ` · ${compact(name, 32)}` : ''}${suffix}` }];
  }
  const result: Atom[] = []; let segment: ShellToken[] = [];
  for (const token of [...tokens, { text: ';', operator: true }]) {
    if (token.operator) { if (segment.length) result.push(...shellSegment(segment)); segment = []; }
    else segment.push(token);
  }
  return result.length ? result : [atom('command:unparsed', '命令（未解析）')];
}
function toolActions(rawName: string, input: unknown): Atom[] {
  const name = normalized(rawName);
  const entries = toolActionInputs(rawName, input);
  // Wrapper atoms already carry their concrete nested tool names. Never label
  // all of them exec or infer that a nested call owns the wrapper's output.
  if (['exec', 'functions__exec'].includes(name)) return entries;
  return entries.map(entry => ({ ...entry, toolName: name,
    key: JSON.stringify(['named-tool', name, entry.key]) }));
}

function toolActionInputs(rawName: string, input: unknown): Atom[] {
  const name = normalized(rawName); const args = object(input);
  if (['exec', 'functions__exec'].includes(name)) return typeof input === 'string' ? wrapperActions(input) : [unresolved()];
  if (['exec_command', 'Bash'].includes(name)) {
    const actions = commandActions(string(args.cmd) || string(args.command));
    // A recorded Bash description is the Agent's own stated purpose, not a
    // Sidecar-generated summary. Use it only when static syntax stays opaque.
    if (name === 'Bash' && string(args.description).trim() && actions.length === 1 && actions[0].label.startsWith('命令')) {
      return [{ ...actions[0], label: `命令 · ${compact(string(args.description), 84)}` }];
    }
    return actions;
  }
  if (name === 'Read') return readActions([string(args.file_path)].filter(Boolean));
  if (name === 'Skill') return [atom('skill:invoke', 'Skill', [string(args.skill)].filter(Boolean))];
  if (['Edit', 'Write'].includes(name)) return [fileAtom(name.toLowerCase(), name === 'Edit' ? '修改文件' : '写入文件', [string(args.file_path)].filter(Boolean))];
  if (name === 'Glob' || name === 'Grep') return [searchAtom(name === 'Glob' ? '查找文件' : '搜索代码', string(args.pattern), [string(args.path)].filter(Boolean), args)];
  if (name === 'ToolSearch') return [atom('search:tools', '查找工具', [string(args.query)].filter(Boolean))];
  if (name === 'WebSearch') return [atom('web:search', 'Web · 搜索资料', [string(args.query)].filter(Boolean))];
  if (name === 'WebFetch') return [atom('web:fetch', 'Web · 读取网页', [string(args.url)].filter(Boolean))];
  if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : string(args.patch);
    const targets = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]);
    return [fileAtom('patch', '修改文件', unique(targets))];
  }
  if (name === 'web__run' || name === 'web.run') {
    const actions: Atom[] = [];
    const fields: [string, string, string][] = [['search_query', '搜索资料', 'q'], ['open', '打开来源', 'ref_id'], ['find', '页内查找', 'pattern'], ['click', '打开来源', 'ref_id'], ['image_query', '搜索图片', 'q'], ['screenshot', '查看页面截图', 'ref_id'], ['finance', '查询行情', 'ticker'], ['weather', '查询天气', 'location'], ['sports', '查询赛事', 'fn'], ['time', '查询时间', 'utc_offset']];
    // Object property order reflects recorded source order, not an invented workflow.
    for (const field of Object.keys(args)) {
      const definition = fields.find(([key]) => key === field);
      if (definition && Array.isArray(args[field])) {
        const targets = (args[field] as unknown[]).map(value => string(object(value)[definition[2]])).filter(Boolean);
        const visible = unique(targets.map(value => ['open', 'click', 'screenshot'].includes(field) ? webSource(value) : webQuery(value)).filter(Boolean));
        const hint = visible[0] ? ` · ${visible[0]}${visible.length > 1 ? ` 等 ${visible.length} 项` : ''}` : '';
        actions.push({ ...atom(`web:${field}`, '', targets), key: JSON.stringify([`web:${field}`, args[field]]), label: `Web · ${definition[1]}${hint}` });
      }
    }
    return actions.length ? actions : [atom('web:run', 'Web · 工具调用')];
  }
  if (/^(?:collaboration__)?(?:spawn_agent|followup_task|send_message|interrupt_agent|list_agents|wait_agent)$/.test(name) || ['Agent', 'Task'].includes(name)) {
    const target = string(args.task_name) || string(args.target) || string(args.description) || string(args.subagent_type);
    const action = name.replace(/^collaboration__/, '');
    const verb = ({ spawn_agent: '分派子任务', followup_task: '继续子任务', send_message: '联系子任务', interrupt_agent: '中断子任务', list_agents: '查看子任务', wait_agent: '等待子任务', Agent: '分派子任务', Task: '分派子任务' } as Record<string, string>)[action];
    return [atom(`subagent:${action}`, verb, [target].filter(Boolean))];
  }
  if (name === 'request_user_input' || name === 'AskUserQuestion') {
    const questions = Array.isArray(args.questions) ? args.questions.map(value => string(object(value).question)).filter(Boolean) : [];
    return [atom('question', '等待确认', questions)];
  }
  if (name === 'view_image') return [fileAtom('image:view', '查看图片', [string(args.path)].filter(Boolean))];
  if (name === 'Web 来源') return [atom('web:result', 'Web · 来源结果')];
  if (name === 'write_stdin' || name === 'wait') return [atom('tool:wait', name === 'write_stdin' && string(args.chars) ? '发送终端输入' : '读取后续输出')];
  return [atom(`tool:${name}`, compact(name || '工具调用', 96))];
}

/** Present semantic input facts without mutating, replacing, or dropping the original evidence. */
export function describeAction(item: TimelineItem): ActionDescription {
  const input = item.detail?.blocks.find(block => ['记录中的调用参数', '当时调用参数'].includes(block.label) && (block.kind === 'code' || block.kind === 'json'))?.text;
  const command = item.detail?.blocks.find(block => block.label === '当时命令' && block.kind === 'code')?.text;
  let actions: Atom[];
  if (command !== undefined) actions = commandActions(command);
  else if (input !== undefined) {
    let decoded: unknown = input;
    try { decoded = JSON.parse(input); } catch { /* Custom tool input is not JSON. */ }
    actions = toolActions(item.title, decoded);
  } else if (item.kind === 'file-change') {
    const patched = item.detail?.blocks.filter(block => block.kind === 'patch').map(block => block.label) || [];
    // A fragment the agent was shown of a file changed outside its own edits names only the file.
    const targets = patched.length ? patched : [item.summary].filter(Boolean);
    actions = [fileAtom('file-change', '文件变化', targets)];
  } else if (item.kind === 'question') actions = [atom('question', '等待确认')];
  else if (item.kind === 'subagent') {
    const label = item.detail?.blocks.some(block => block.label === '子 Agent 返回') ? '子任务返回'
      : item.status === 'completed' ? '子任务完成' : item.status === 'running' ? '子任务进行中' : '子任务';
    actions = [atom('subagent', label, [item.title].filter(value => value !== '子 Agent'))];
  }
  else actions = toolActions(item.title, undefined);
  const entries: ActionEntry[] = [];
  for (const action of actions) {
    const existing = entries.find(entry => entry.key === action.key);
    if (existing) existing.count++;
    else entries.push({ ...action, count: 1 });
  }
  const targets = unique(entries.flatMap(entry => entry.targets || []));
  // The compact rail gets a bounded summary; entries retain every decoded action.
  const label = compact(entries.map(entry => `${entry.label}${entry.count > 1 ? ` ×${entry.count}` : ''}`).join('；'), 240);
  return { label, key: JSON.stringify(entries.map(entry => [entry.key, entry.count])), ...(targets.length ? { targets } : {}), entries, ...(entries.some(entry => entry.label === '编排调用（未解析）') ? { unresolved: true } : {}) };
}

/** Split a grounded semantic entry into a strong token and its compact purpose.
 * This is presentation only: it neither reclassifies raw text nor modifies the
 * original evidence identity, repetition count, or execution status.
 */
export function actionPresentation(entry: ActionEntry): ActionPresentation {
  let kind = '';
  try {
    let identity: unknown = JSON.parse(entry.key);
    if (Array.isArray(identity) && identity[0] === 'named-tool' && typeof identity[2] === 'string') identity = JSON.parse(identity[2]);
    if (Array.isArray(identity) && typeof identity[0] === 'string') kind = identity[0];
  } catch { /* Legacy/malformed identities remain generic tools. */ }
  let type: ActionType = 'TOOL';
  if (kind === 'invocation') type = ({ Bash: 'BASH', Read: 'READ', apply_patch: 'EDIT', Edit: 'EDIT', Write: 'WRITE', Skill: 'SKILL', WebSearch: 'WEB', WebFetch: 'WEB', web__run: 'WEB', Grep: 'SEARCH', Glob: 'SEARCH', ToolSearch: 'SEARCH', exec: 'UNKNOWN' } as Record<string, ActionType>)[entry.toolName ?? ''] ?? 'TOOL';
  if (kind === 'orchestration:unresolved') type = 'UNKNOWN';
  else if (kind.startsWith('command:')) type = 'BASH';
  else if (kind === 'read' || kind === 'list') type = 'READ';
  else if (kind === 'skill:read' || kind === 'skill:invoke') type = 'SKILL';
  else if (kind.startsWith('web:')) type = 'WEB';
  else if (kind === 'search:files' || kind === 'search:tools') type = 'SEARCH';
  else if (kind === 'test') type = 'TEST';
  else if (kind === 'build') type = 'BUILD';
  else if (kind === 'edit' || kind === 'patch') type = 'EDIT';
  else if (kind === 'write') type = 'WRITE';
  else if (kind === 'file-change') type = 'FILE';
  else if (kind === 'subagent' || kind.startsWith('subagent:')) type = 'AGENT';
  else if (kind === 'question') type = 'ASK';
  else if (kind === 'image:view') type = 'IMAGE';
  else if (kind.startsWith('git:')) type = 'GIT';
  else if (kind === 'dependencies') type = 'INSTALL';
  else if (kind === 'tool:wait') type = 'WAIT';

  // Prefix removal is selected by the trusted semantic kind. An arbitrary tool
  // label mentioning Skill, Web, or test cannot manufacture the corresponding token.
  const prefixes: Partial<Record<ActionType, readonly string[]>> = {
    BASH: ['命令 · '], READ: ['读取 · ', '查看目录 · '], SKILL: ['Skill · '], WEB: ['Web · '],
    TEST: ['验证 · ', '测试 · '], BUILD: ['构建 · '], EDIT: ['修改文件 · '], WRITE: ['写入文件 · '],
    FILE: ['文件变化 · '], IMAGE: ['查看图片 · '],
  };
  let label = compact(entry.label, 240);
  const prefix = prefixes[type]?.find(value => label.startsWith(value));
  if (prefix && label.length > prefix.length) label = label.slice(prefix.length);
  return { type: entry.displayType ?? type, label: entry.displayType ? entry.label : label || '工具调用' };
}
