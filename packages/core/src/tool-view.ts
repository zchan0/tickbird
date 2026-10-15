import { exploreText } from './command-line';
import { shellReadRange, shellReadTargets, skillPath, summarizeShell, execCommandHint, type ActionType } from './actions';
import { t } from './i18n';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const compact = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
const basename = (path: string): string => path.replace(/\\/g, '/').split('/').at(-1) || path;
/** A web address without its scheme: the narrow column keeps what tells pages apart. */
const site = (value: string): string => value.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');
/** Keys sent to a terminal, as their names: \u0003 is Ctrl-C. */
const keys = (chars: string): string => [...chars].map(char => {
  const code = char.charCodeAt(0);
  if (char === '\r' || char === '\n') return ' Enter ';
  if (char === '\t') return ' Tab ';
  if (code === 27) return ' Esc ';
  if (code < 32) return ` Ctrl-${String.fromCharCode(code + 64)} `;
  if (code === 127) return ' Backspace ';
  return char;
}).join('').replace(/\s+/g, ' ').trim();
const humanize = (value: string): string => value.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
/** An MCP server's identifier as a short app name for the tool column: claude-in-chrome → Chrome. */
function mcpApp(server: string): string {
  const words = server.replace(/^claude[_-]ai[_-]/i, '').replace(/^claude[_-](?:in[_-])?(?=\w)/i, '').split(/[-_]+/).filter(Boolean);
  const name = words.map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  return name.length <= 8 || words.length === 1 ? name : words[0][0].toUpperCase() + words[0].slice(1);
}
/** What the server was asked to do, without repeating the app: notion-create-pages → create pages. */
const mcpOperation = (app: string, operation: string): string =>
  operation.replace(new RegExp(`^${app.split(' ')[0]}[-_]`, 'i'), '').replace(/_mcp$/, '').replace(/[_-]+/g, ' ');
export interface ToolView { name: string; label: string; type: ActionType; paths?: string[]; operation?: string }

/** A file read with the lines read, where the call says: outline.ts:85-135. */
const lines = (path: string, start?: number, end?: number): string =>
  basename(path) + (start === undefined || (start === 1 && end === undefined) ? '' : end === undefined ? `:${start}-` : end === start ? `:${start}` : `:${start}-${end}`);

function readView(paths: string[], range?: { start?: number; end?: number }): ToolView {
  const skills = paths.map(skillPath);
  if (skills.every(Boolean)) return { name: 'Skill', label: `${skills.join(t(', ', '、'))} · ${t('read its definition', '读取定义')}`, type: 'SKILL', paths };
  if (paths.every(path => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(path))) return { name: 'Instructions', label: paths.map(basename).join('、'), type: 'READ', paths };
  if (paths.every(path => /(?:^|\/)(?:MEMORY|memory_summary)\.md$/.test(path) || /\/(?:\.codex\/memories|\.claude\/[^\s]*memory)\//.test(path))) return { name: 'Memory', label: paths.map(basename).join('、'), type: 'READ', paths };
  return { name: 'Read', label: paths.length === 1 && range ? lines(paths[0], range.start, range.end) : paths.map(basename).join('、'), type: 'READ', paths };
}

/** What a web operation did, as the row says it: the same words as the tools' own names. */
const webVerbs: Record<string, string> = { search_query: 'Search', image_query: 'Image search', open: 'Open', click: 'Click', find: 'Find', screenshot: 'Screenshot', finance: 'Finance', weather: 'Weather', sports: 'Sports', time: 'Time' };
const webOperations: Record<string, [string, string, string]> = {
  search_query: ['WebSearch', '搜索', 'q'], image_query: ['ImageSearch', '搜索图片', 'q'],
  open: ['WebFetch', '打开', 'ref_id'], click: ['WebClick', '打开链接', 'id'], find: ['WebFind', '页内查找', 'pattern'],
  screenshot: ['Screenshot', '页面截图', 'ref_id'], finance: ['Finance', '行情', 'ticker'], weather: ['Weather', '天气', 'location'],
  sports: ['Sports', '赛事', 'fn'], time: ['Time', '时间', 'utc_offset'],
};
export function webInputRows(input: unknown): Array<[string, string]> {
  return Object.entries(object(input)).flatMap(([key, values]) => {
    const operation = webOperations[key];
    if (!operation || !Array.isArray(values)) return [];
    return values.map(value => {
      const args = object(value), target = args[operation[2]];
      const detail = target === undefined ? JSON.stringify(value) : String(target);
      return [operation[1], detail] as [string, string];
    });
  });
}

/**
 * A tool we do not know, by its input: what it was asked to do (action,
 * intent), then what it worked on (a page, a file, a title); else the first
 * short value with its key. Never the keys alone: they say nothing.
 */
function unknownLabel(args: Record<string, unknown>): string {
  const verbs = ['action', 'operation', 'intent', 'mode'].map(key => text(args[key])).filter(value => value && value.length <= 24);
  const url = text(args.url), file = text(args.file_path) || text(args.path);
  const words = ['title', 'name', 'query', 'description', 'target', 'command', 'cmd', 'prompt'].map(key => text(args[key])).find(Boolean) || '';
  // A page or a file, and the words that say what it is: v4.html · 终端 Tickbird 的设计稿.
  const target = [(url && site(url)) || (file && basename(file)), words].filter(Boolean).join(' · ');
  if (verbs.length || target) return [...verbs.slice(0, 2), target].filter(Boolean).join(' · ');
  const first = Object.entries(args).find(([, value]) => typeof value === 'string' && value.trim() || typeof value === 'number');
  return first ? `${first[0]} ${String(first[1])}` : '';
}

/** Deterministic presentation of recorded fields, not generated intent or execution status. */
export function toolView(rawName: string, input: unknown): ToolView {
  const name = rawName.replace(/^functions[/.]/, '').replace(/\//g, '__');
  const args = object(input);
  if (['exec_command', 'Bash'].includes(name)) {
    const command = text(args.cmd) || text(args.command), paths = shellReadTargets(command);
    if (paths) return readView(paths, shellReadRange(command));
    // A command that only reads, searches or lists files goes by that tool's name, as Codex names it.
    const explored = command ? exploreText(command, '', '') : undefined;
    if (explored) return { name: explored.tool, label: compact(text(args.description)) || explored.text, type: explored.tool === 'Read' ? 'READ' : 'SEARCH' };
    return { name: 'Bash', label: compact(text(args.description)) || (command ? summarizeShell(command) : t('command not recorded', '命令未记录')), type: 'BASH' };
  }
  if (name === 'Read' && text(args.file_path)) {
    const offset = typeof args.offset === 'number' ? args.offset : undefined, limit = typeof args.limit === 'number' ? args.limit : undefined;
    return readView([text(args.file_path)], offset === undefined && limit === undefined ? undefined : { start: offset ?? 1, ...(limit ? { end: (offset ?? 1) + limit - 1 } : {}) });
  }
  if (name === 'Skill') return { name, label: text(args.skill).replace(/^\//, ''), type: 'SKILL' };
  if (['web__run', 'web.run'].includes(name)) {
    const operations = Object.keys(args).filter(key => webOperations[key] && Array.isArray(args[key]));
    const targets = operations.flatMap(key => (args[key] as unknown[]).map(value => {
      const target = object(value)[webOperations[key][2]];
      const shown = target === undefined ? JSON.stringify(value) : key === 'click' ? `#${String(target)}` : site(String(target));
      return operations.length === 1 ? shown : `${webVerbs[key]} ${shown}`;
    }));
    return { name: operations.length === 1 ? webOperations[operations[0]][0] : 'Web', label: compact(targets.join('；')), type: 'WEB' };
  }
  if (['WebSearch', 'WebFetch'].includes(name)) return { name, label: compact(text(args.query) || site(text(args.url))), type: 'WEB' };
  // select:A,B loads tools by name: the names are what it asked for.
  if (name === 'ToolSearch') return { name, label: compact(text(args.query).replace(/^select:/, '').split(',').join(', ')), type: 'SEARCH' };
  if (['Grep', 'Glob'].includes(name)) return { name, label: compact([text(args.pattern) || text(args.query), text(args.path)].filter(Boolean).join(' · ')), type: 'SEARCH' };
  if (['Edit', 'Write', 'apply_patch'].includes(name)) return { name: 'Write', label: basename(text(args.file_path)), type: 'WRITE' };
  if (name === 'exec') {
    const hint = execCommandHint(text(input));
    return { name: 'Script', label: hint ? /\[cmd:/.test(hint) ? t('calls Bash · dynamic arguments', '调用 Bash · 动态参数') : t('calls Bash · ', '调用 Bash · ') + hint.replace(/^\[|\]$/g, '') : t('runs a tool script', '运行工具编排脚本'), type: 'TOOL' };
  }
  const goals: Record<string, string> = { get_goal: t('view the goal', '查看目标'), create_goal: t('set the goal', '设定目标'), update_goal: t('update the goal', '更新目标') };
  if (goals[name]) return { name: 'Goal', label: compact([goals[name], text(args.objective) || text(args.status)].filter(Boolean).join(' · ')), type: 'TOOL', operation: goals[name] };
  if (['update_plan', 'TodoWrite'].includes(name)) return { name: 'Plan', label: text(args.explanation) || t('update the plan', '更新计划'), type: 'TOOL' };
  if (['wait', 'write_stdin'].includes(name)) return { name: 'Terminal', label: text(args.chars) ? t('type · ', '输入 · ') + compact(keys(text(args.chars))) : t('read more output', '读取后续输出'), type: 'WAIT' };
  if (name === 'SendMessage') return { name, label: compact([text(args.to), text(args.message) || text(args.summary)].filter(Boolean).join(' · ')), type: 'AGENT' };
  if (['request_user_input', 'request_user_input_async', 'AskUserQuestion'].includes(name)) return { name: 'Ask', label: compact(Array.isArray(args.questions) ? args.questions.map(value => text(object(value).question) || text(object(value).title)).join('；') : ''), type: 'ASK' };
  const agent = /^(?:collaboration[._/]+)?(spawn_agent|followup_task|send_message|interrupt_agent|list_agents|wait_agent)$/.exec(name);
  if (agent || ['Agent', 'Task'].includes(name)) {
    const verbs: Record<string, string> = { spawn_agent: t('start', '分派'), followup_task: t('continue', '继续'), send_message: t('message', '发送消息'), interrupt_agent: t('interrupt', '中断'), list_agents: t('list subagents', '查看子任务'), wait_agent: t('wait for subagents', '等待子任务') };
    return { name: 'Agent', label: compact([agent ? verbs[agent[1]] : '', text(args.description) || text(args.task_name) || text(args.target)].filter(Boolean).join(' · ')), type: 'AGENT' };
  }
  if (name === 'view_image') return { name: 'Image', label: basename(text(args.path)), type: 'IMAGE' };
  if (name === 'clock__curr_time') return { name: 'Clock', label: t('read the current time', '读取当前时间'), type: 'TOOL' };
  const mcp = /^mcp__(.+?)(?:__|\.)(.+)$/.exec(name);
  if (mcp) {
    let [, server, operation] = mcp;
    // Codex reaches its connected apps through one server: the app is the operation's first word, notion.fetch.
    const connected = server === 'codex_apps' ? /^([a-z0-9]+)[._](.+)$/i.exec(operation) : null;
    if (connected) [, server, operation] = connected;
    const title = text(args.title) || text(args.description);
    const target = ['query', 'url', 'path', 'search', 'pattern', 'target', 'id'].map(key => text(args[key])).find(Boolean) || '';
    if (server === 'cua_repl') return { name: 'Computer', label: compact(title || (operation === 'js' ? t('run JavaScript', '执行 JavaScript') : humanize(operation))), type: 'TOOL', operation };
    if (server === 'node_repl') return { name: 'JS', label: compact(title || (operation === 'js' ? t('run code', '运行代码') : t('reset the runtime', '重置运行环境'))), type: 'TOOL', operation };
    const app = mcpApp(server);
    return { name: app, label: compact([mcpOperation(app, operation), title || site(target) || text(args.action)].filter(Boolean).join(' · ')), type: 'TOOL', operation };
  }
  return { name: name === 'exec' ? 'exec' : humanize(name.replace(/[._/]+/g, ' ')), label: compact(unknownLabel(args)), type: name === 'exec' ? 'UNKNOWN' : 'TOOL' };
}
