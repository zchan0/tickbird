// Synthetic browser geometry check, not a live Agent or VS Code bridge.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LiveView } = require('../dist/packages/vscode/src/live-view.js');
const { renderSidecar } = require('../dist/packages/vscode/src/render.js');
const nonce = randomBytes(18).toString('hex'), path = '/' + randomBytes(18).toString('hex');
const item = (id, turnId, text) => ({ id, turnId, sessionId: 'browser-fixture', kind: 'message', title: '过程说明', summary: text,
  status: 'info', availability: 'available', sources: [{ file: 'synthetic-fixture', line: 1 }], detail: { title: '过程说明', blocks: [{ kind: 'text', label: '正文', text }] } });
const data = { id: 'browser-fixture', provider: 'codex', projectPath: '/synthetic', title: '实时增量 · 合成测试', warnings: [], coverage: [], items: [
  item('old', 'old', '旧回合：这个位置在更新后应保持不动。'),
  ...['a.ts', 'b.ts'].map(id => ({ ...item(id, 'old', 'Read'), kind: 'tool', title: 'Read', result: 'not-observed', detail: { title: 'Input', blocks: [{ kind: 'json', label: '当时调用参数', text: JSON.stringify({ file_path: '/synthetic/' + id }) }] } })),
  ...Array.from({ length: 5 }, (_, i) => item('current-' + i, 'current', `**检查 ${i + 1}**\n\n正在核对工作过程的展示。新增内容不能抢走阅读位置。\n\n- 调用与结果分开记录\n- 阅读状态由使用者决定`)),
] };
const view = new LiveView('synthetic', data), health = { state: 'observing', pendingBytes: 0, readBytes: 100 };
const html = renderSidecar({ projectName: 'synthetic', session: data, streamId: view.streamId, nonce }, view.current);
const reset = view.update(data, health, true);
data.items.push(item('appended-current', 'current', '**自动追加模拟**：当前回合已取得新输出。'));
const append = view.update(data, health);
data.items.push(item('newest', 'newest', '**新回合模拟**：出现在最上方，旧回合位置保持。'));
const prepend = view.update(data, health);
const safe = value => JSON.stringify(value).replace(/</g, '\\u003c');
const bootstrap = `<script nonce="${nonce}">let saved;let phase=0;const reset=${safe(reset)},updates=${safe([append, prepend])};window.acquireVsCodeApi=()=>({getState:()=>saved,setState:s=>{saved=s;},postMessage:m=>{if(m.type==='observerReady')setTimeout(()=>window.postMessage(reset,'*'),0);if(m.type==='refresh'&&updates[phase])window.postMessage(updates[phase++],'*');}});</script>`;
const theme = `<style nonce="${nonce}">:root{--vscode-foreground:#ddd;--vscode-editor-background:#181a1b;--vscode-sideBar-background:#1d1f20;--vscode-panel-border:#333;--vscode-descriptionForeground:#999;--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-focusBorder:#75a7cc;--vscode-textCodeBlock-background:#25282a;--vscode-charts-green:#77ab83;--vscode-editorWarning-foreground:#d2ba76;--vscode-list-hoverBackground:#292c2e;--vscode-list-inactiveSelectionBackground:#34383b}</style>`;
const page = html.replace('</head>', theme + bootstrap + '</head>');
const server = createServer((request, response) => {
  if (request.url !== path) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' }); response.end(page);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ kind: 'synthetic-browser-live-check', url: 'http://127.0.0.1:' + server.address().port + path, instruction: 'Refresh once appends to current turn; twice prepends a new turn. Never executes recorded actions.' })));
