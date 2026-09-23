import { shellReadTargets, skillPath, summarizeShell, execCommandHint, type ActionType } from './actions';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const compact = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
const basename = (path: string): string => path.replace(/\\/g, '/').split('/').at(-1) || path;
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

function readView(paths: string[]): ToolView {
  const skills = paths.map(skillPath);
  if (skills.every(Boolean)) return { name: 'Skill', label: `${skills.join('、')} · 读取定义`, type: 'SKILL', paths };
  if (paths.every(path => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(path))) return { name: 'Instructions', label: paths.map(basename).join('、'), type: 'READ', paths };
  if (paths.every(path => /(?:^|\/)(?:MEMORY|memory_summary)\.md$/.test(path) || /\/(?:\.codex\/memories|\.claude\/[^\s]*memory)\//.test(path))) return { name: 'Memory', label: paths.map(basename).join('、'), type: 'READ', paths };
  return { name: 'Read', label: paths.map(basename).join('、'), type: 'READ', paths };
}

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

/** Deterministic presentation of recorded fields, not generated intent or execution status. */
export function toolView(rawName: string, input: unknown): ToolView {
  const name = rawName.replace(/^functions[/.]/, '').replace(/\//g, '__');
  const args = object(input);
  if (['exec_command', 'Bash'].includes(name)) {
    const command = text(args.cmd) || text(args.command), paths = shellReadTargets(command);
    return paths ? readView(paths) : { name: 'Bash', label: compact(text(args.description)) || (command ? summarizeShell(command) : '命令未记录'), type: 'BASH' };
  }
  if (name === 'Read' && text(args.file_path)) return readView([text(args.file_path)]);
  if (name === 'Skill') return { name, label: text(args.skill).replace(/^\//, ''), type: 'SKILL' };
  if (['web__run', 'web.run'].includes(name)) {
    const operations = Object.keys(args).filter(key => webOperations[key] && Array.isArray(args[key]));
    return { name: operations.length === 1 ? webOperations[operations[0]][0] : 'Web',
      label: compact(webInputRows(args).map(([operation, target]) => `${operations.length === 1 ? '' : operation + ' · '}${target}`).join('；')),
      type: 'WEB' };
  }
  if (['WebSearch', 'WebFetch'].includes(name)) return { name, label: compact(text(args.query) || text(args.url)), type: 'WEB' };
  if (['Grep', 'Glob', 'ToolSearch'].includes(name)) return { name, label: compact([text(args.pattern) || text(args.query), text(args.path)].filter(Boolean).join(' · ')), type: 'SEARCH' };
  if (['Edit', 'Write', 'apply_patch'].includes(name)) return { name: 'Write', label: basename(text(args.file_path)), type: 'WRITE' };
  if (name === 'exec') {
    const hint = execCommandHint(text(input));
    return { name: 'Script', label: hint ? /\[cmd:/.test(hint) ? '调用 Bash · 动态参数' : '调用 Bash · ' + hint.replace(/^\[|\]$/g, '') : '运行工具编排脚本', type: 'TOOL' };
  }
  const goals: Record<string, string> = { get_goal: '查看目标', create_goal: '设定目标', update_goal: '更新目标' };
  if (goals[name]) return { name: 'Goal', label: compact([goals[name], text(args.objective) || text(args.status)].filter(Boolean).join(' · ')), type: 'TOOL', operation: goals[name] };
  if (['update_plan', 'TodoWrite'].includes(name)) return { name: 'Plan', label: text(args.explanation) || '更新计划', type: 'TOOL' };
  if (['wait', 'write_stdin'].includes(name)) return { name: 'Terminal', label: text(args.chars) ? '输入 · ' + compact(text(args.chars)) : '读取后续输出', type: 'WAIT' };
  if (['request_user_input', 'request_user_input_async', 'AskUserQuestion'].includes(name)) return { name: 'Ask', label: compact(Array.isArray(args.questions) ? args.questions.map(value => text(object(value).question) || text(object(value).title)).join('；') : ''), type: 'ASK' };
  const agent = /^(?:collaboration[._/]+)?(spawn_agent|followup_task|send_message|interrupt_agent|list_agents|wait_agent)$/.exec(name);
  if (agent || ['Agent', 'Task'].includes(name)) {
    const verbs: Record<string, string> = { spawn_agent: '分派', followup_task: '继续', send_message: '发送消息', interrupt_agent: '中断', list_agents: '查看子任务', wait_agent: '等待子任务' };
    return { name: 'Agent', label: compact([agent ? verbs[agent[1]] : '', text(args.description) || text(args.task_name) || text(args.target)].filter(Boolean).join(' · ')), type: 'AGENT' };
  }
  if (name === 'view_image') return { name: 'Image', label: basename(text(args.path)), type: 'IMAGE' };
  if (name === 'clock__curr_time') return { name: 'Clock', label: '读取当前时间', type: 'TOOL' };
  const mcp = /^mcp__(.+?)(?:__|\.)(.+)$/.exec(name);
  if (mcp) {
    const [, server, operation] = mcp;
    const title = text(args.title) || text(args.description);
    const target = ['query', 'url', 'path', 'search', 'pattern', 'target'].map(key => text(args[key])).find(Boolean) || '';
    if (server === 'cua_repl') return { name: 'Computer', label: compact(title || (operation === 'js' ? '执行 JavaScript' : humanize(operation))), type: 'TOOL', operation };
    if (server === 'node_repl') return { name: 'JS', label: compact(title || (operation === 'js' ? '运行代码' : '重置运行环境')), type: 'TOOL', operation };
    const app = mcpApp(server);
    return { name: app, label: compact([mcpOperation(app, operation), title || target || text(args.action)].filter(Boolean).join(' · ')), type: 'TOOL', operation };
  }
  const target = ['description', 'title', 'query', 'url', 'path', 'file_path', 'target', 'command', 'cmd'].map(key => text(args[key])).find(Boolean);
  return { name: name === 'exec' ? 'exec' : humanize(name.replace(/[._/]+/g, ' ')), label: compact(target || (Object.keys(args).length ? `参数 · ${Object.keys(args).join('、')}` : '')), type: name === 'exec' ? 'UNKNOWN' : 'TOOL' };
}
