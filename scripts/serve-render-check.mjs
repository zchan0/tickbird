import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseCodex } = require('../dist/packages/core/src/codex.js');
const { parseClaude } = require('../dist/packages/core/src/claude.js');
const { renderDetail, renderSidecar } = require('../dist/packages/vscode/src/render.js');
const { groupSessionTurns } = require('../dist/packages/core/src/timeline.js');
const { outlineTurn, actionRows, actionRowSections, resolveOutlineEvidence } = require('../dist/packages/core/src/outline.js');
const { describeAction } = require('../dist/packages/core/src/actions.js');
const { applyCodexSessionTitle } = require('../dist/packages/core/src/session-title.js');
const projectPath = '/Users/me/Developer/agent-sidecar';
const samples = [
  ['CX2', 'codex', '/Users/me/.codex/sessions/2026/09/04/rollout-2026-09-04T18-52-56-01a00000-0000-7000-8000-0000000000c2.jsonl', 1282],
  ['CL1', 'claude', '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a1.jsonl', 1133],
  ['CL2', 'claude', '/Users/me/.claude/projects/-Users-me-Developer-agent-sidecar/00000000-0000-4000-8000-0000000000a3.jsonl', 244]
];
const cases = new Map();
const nonce = randomBytes(18).toString('base64');
const prefix = '/' + randomBytes(18).toString('hex');
// Browser-only bridge fixture: Keep acknowledges state without a real VS Code
// tab; Refresh reloads this page with page-local state. Neither proves host UI.
const bootstrap = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({getState:()=>JSON.parse(sessionStorage.getItem(location.pathname)||'null'),setState:s=>sessionStorage.setItem(location.pathname,JSON.stringify(s)),postMessage:m=>{if(m.type==='keep')window.postMessage({type:'kept'},'*');if(m.type==='refresh')location.reload();}});</script>`;
const theme = `<style nonce="${nonce}">:root{--vscode-foreground:#24292f;--vscode-editor-background:#fff;--vscode-sideBar-background:#f8f8f8;--vscode-panel-border:#ddd;--vscode-descriptionForeground:#626b74;--vscode-editorWarning-foreground:#8b6508;--vscode-font-family:system-ui;--vscode-focusBorder:#007acc;--vscode-errorForeground:#b42318;--vscode-charts-green:#388a34;--vscode-charts-blue:#007acc;--vscode-charts-purple:#8542b4;--vscode-charts-orange:#a96912;--vscode-textCodeBlock-background:#f6f8fa;--vscode-diffEditor-insertedTextBackground:#ddfbe6;--vscode-diffEditor-removedTextBackground:#ffebe9}</style>`;
// Explicit synthetic browser regression, separate from all fixed real samples.
cases.set('SHORT-TURNS-sidecar', renderSidecar({ projectName: '短回合测试', nonce, session: {
  id: 'short-turn-fixture', provider: 'codex', projectPath, title: '短回合定位测试（合成）', warnings: [], coverage: [],
  items: [1, 2].flatMap(turn => [
    { id: `q${turn}`, sessionId: 'short-turn-fixture', turnId: `short-${turn}`, kind: 'request', title: '用户请求', summary: `第 ${turn} 次简短请求`, status: 'info', availability: 'none', sources: [] },
    { id: `a${turn}`, sessionId: 'short-turn-fixture', turnId: `short-${turn}`, kind: 'message', title: '过程说明', summary: '已核对这一项。', status: 'info', availability: 'none', sources: [] },
  ]),
} }));
// Explicit presentation fixture: missing/empty/readable returns, source-only
// empty turns, and exceptional rows. These are not observations of a real run.
const foldSessionId = 'folding-fixture';
const foldItem = (id, kind, title, summary, extra = {}) => ({
  id, sessionId: foldSessionId, turnId: 'fold-4', kind, title, summary,
  status: 'info', availability: 'none', sources: [{ file: 'synthetic-folding-fixture', line: 1 }], ...extra,
});
const foldTool = (id, cmd, result, status = 'completed', output) => foldItem(id, 'tool', 'exec_command', cmd, {
  status, result, availability: 'available', detail: { title: cmd, blocks: [
    { kind: 'json', label: '当时调用参数', text: JSON.stringify({ cmd }) },
    ...(output ? [{ kind: 'text', label: '当时返回', text: output }] : []),
  ] },
});
cases.set('FOLDING-sidecar', renderSidecar({ projectName: '折叠测试', nonce, session: {
  id: foldSessionId, provider: 'codex', projectPath, title: '窄版动作折叠（合成测试）', warnings: [], coverage: [],
  items: [
    foldItem('boundary-start', 'notice', '回合开始', '已记录回合开始。', { turnId: 'fold-1' }),
    foldItem('boundary-end', 'notice', '回合结束', '已记录回合结束。', { turnId: 'fold-1' }),
    foldItem('answer-only', 'answer', '历史回答', '单独取得的回答仍保留。', { turnId: 'fold-2', availability: 'available', detail: { title: '历史回答', blocks: [{ kind: 'text', label: '公开正文', text: '单独取得的回答仍保留。' }] } }),
    foldItem('request-only', 'request', '用户请求', '只有问题、尚无过程的回合也保留。', { turnId: 'fold-3' }),
    foldItem('fold-question', 'request', '用户请求', '先检查项目结构，再运行测试。'),
    foldItem('fold-narrative', 'message', '过程说明', '先核对文件和构建配置，有结果时再查看详情。'),
    foldTool('no-return-read', 'sed -n "1,20p" README.md', 'not-observed', 'unknown'),
    foldTool('empty-return-test', 'npm test', 'empty'),
    foldTool('readable-return', 'rg --files packages', 'readable', 'completed', 'packages/core/src/model.ts\npackages/vscode/src/render.ts'),
    foldTool('after-result', 'pwd', 'empty'),
    foldTool('failed-visible', 'npm run check', 'readable', 'failed', 'Type check failed (synthetic).'),
    foldTool('running-visible', 'npm run build', 'not-observed', 'running'),
    foldItem('subagent-visible', 'subagent', '子任务 · review', '已取得主会话中的子任务返回。', { result: 'readable', availability: 'available', detail: { title: '子任务返回', blocks: [{ kind: 'text', label: '返回', text: '已核对布局。' }] } }),
  ],
} }));
for (const [name, provider, file, lines] of samples) {
  const text = (await readFile(file, 'utf8')).split('\n').slice(0, lines).join('\n') + '\n';
  const parsed = (provider === 'codex' ? parseCodex : parseClaude)({ text, file, projectPath });
  const session = provider === 'codex' ? await applyCodexSessionTitle(parsed) : parsed;
  cases.set(`${name}-sidecar`, renderSidecar({ projectName: 'tickbird · 实际渲染核对', session, nonce }));
  const rows = groupSessionTurns(session).flatMap(turn => outlineTurn(turn).nodes.flatMap(node => node.kind === 'actions' ? actionRows(node) : []));
  const repeated = rows.find(row => row.items.length > 1 && row.description.label !== 'Web · 来源结果');
  const evidence = repeated && resolveOutlineEvidence(session, repeated.id);
  if (evidence) cases.set(`${name}-repeated-action`, renderDetail({ ...evidence, provider, kept: false, nonce }));
  const sharedInput = groupSessionTurns(session).flatMap(turn => outlineTurn(turn).nodes.flatMap(node => node.kind === 'actions'
    ? actionRowSections(node).filter(section => section.kind === 'folded-actions').flatMap(section => section.rows) : []))
    .find(row => row.items.length === 1 && describeAction(row.items[0]).entries.reduce((count, entry) => count + entry.count, 0) > 1);
  const sharedEvidence = sharedInput && resolveOutlineEvidence(session, sharedInput.id);
  if (sharedEvidence) cases.set(`${name}-shared-input`, renderDetail({ ...sharedEvidence, provider, kept: false, nonce }));
  for (const [kind, match] of [
    ['image', item => item.detail?.blocks.some(block => block.kind === 'image')],
    ['patch', item => item.detail?.blocks.some(block => block.kind === 'patch')],
    ['question', item => item.kind === 'question' && item.detail],
    ['subagent', item => item.kind === 'subagent' && item.detail],
    ['failed', item => item.status === 'failed' && item.detail],
    ['partial', item => item.availability === 'partial' && item.detail],
    ['truncated', item => item.detail?.notice?.includes('截断')],
    ['mcp-context', item => item.title === 'mcp__claude-in-chrome__tabs_context_mcp' && item.detail],
    ['tool-references', item => item.title === 'ToolSearch' && item.detail?.blocks.some(block => block.label === 'ToolSearch 返回的工具引用（不代表调用）')],
    ['request', item => item.kind === 'request' && item.detail]
  ]) {
    const item = session.items.find(match);
    if (item) cases.set(`${name}-${kind}`, renderDetail({ item, provider, kept: false, nonce }));
  }
}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const key = url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length + 1) : '';
  if (request.method !== 'GET' || !cases.has(key)) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(cases.get(key).replace('</head>', theme + '</head>').replace(`<script nonce="${nonce}">`, bootstrap + `<script nonce="${nonce}">`));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ kind: 'real-log-render-check-not-extension-host', pid: process.pid,
  routes: [...cases.keys()].map(key => ({ key, url: `http://127.0.0.1:${server.address().port}${prefix}/${key}` })) }, null, 2)));
