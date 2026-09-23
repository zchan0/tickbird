import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { presentationCases } from '../tests/fixtures/presentation-cases';
import { renderDetail, renderSidecar } from '../packages/vscode/src/render';
import { resolveOutlineEvidence, hasReadableEvidence } from '../packages/core/src/outline';

const nonce = randomBytes(18).toString('hex');
const safe = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
const theme = `<style nonce="${nonce}">:root{--vscode-foreground:#d4d4d4;--vscode-editor-background:#191b1c;--vscode-sideBar-background:#191b1c;--vscode-panel-border:#343638;--vscode-descriptionForeground:#94989c;--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-editor-font-family:ui-monospace,monospace;--vscode-editor-font-size:12px;--vscode-textCodeBlock-background:#202224;--vscode-focusBorder:#83a8c6;--vscode-diffEditor-insertedTextBackground:#254737;--vscode-diffEditor-removedTextBackground:#512e30;--vscode-list-hoverBackground:#282b2d;--vscode-editorWarning-foreground:#b7a06e;--vscode-errorForeground:#db8585}</style>`;
function page(html: string, caseId: string) {
  const bridge = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:m=>{if(m.type==='openDetail')parent.postMessage({caseId:${safe(caseId)},id:m.itemId},'*')}});</script>`;
  return html.replace('</head>', theme + bridge + '</head>');
}
const cases = ['zh-cn', 'en'].flatMap(locale => presentationCases.map(sample => {
  const rows = sample.session.items.map(item => item.id);
  // Include actual presentation IDs used by the live panel, not bespoke gallery actions.
  const { groupSessionTurns } = require('../packages/core/src/timeline') as typeof import('../packages/core/src/timeline');
  const { outlineTurn, actionRowSections } = require('../packages/core/src/outline') as typeof import('../packages/core/src/outline');
  groupSessionTurns(sample.session).forEach(turn => outlineTurn(turn).nodes.forEach(node => { if (node.kind === 'actions') rows.push(...actionRowSections(node).flatMap(section => section.rows.map(row => row.id))); }));
  const details = Object.fromEntries(rows.map(id => {
    const evidence = resolveOutlineEvidence(sample.session, id);
    const readable = evidence && (evidence.items ?? [evidence.item]).some(hasReadableEvidence);
    return [id, readable ? page(renderDetail({ ...evidence!, provider: sample.session.provider, kept: false, nonce, locale }), sample.id) : ''];
  }));
  return { id: sample.id, locale, title: sample.title, detailId: sample.detailId, details,
    sidecar: page(renderSidecar({ projectName: '合成样例', session: sample.session, nonce, locale }), sample.id) };
}));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sidecar 展示样例</title><style>body{margin:0;background:#111314;color:#ddd;font:14px/1.6 system-ui}header{padding:16px 24px;border-bottom:1px solid #333}h1{margin:0;font-size:18px}p{margin:4px 0;color:#aaa}select{margin-top:10px;padding:7px;background:#25282a;color:#eee;border:1px solid #444;border-radius:4px;max-width:95vw}.panels{display:grid;grid-template-columns:300px minmax(300px,1fr);gap:16px;max-width:1220px;margin:20px auto;padding:0 20px}iframe{border:1px solid #343638;width:100%;height:760px;box-sizing:border-box;border-radius:6px;background:#191b1c}label{display:block;font-size:12px;color:#999;margin-bottom:8px}[hidden]{display:none!important}@media(max-width:680px){.panels{grid-template-columns:300px}}</style><header><h1>Sidecar 展示样例 · IN / OUT 修订</h1><p>${presentationCases.length} 组合成记录，使用当前插件渲染器。左栏固定 300px；点击动作或 IN / OUT 看完整详情。不是实际 Agent 运行验收。</p><select id="cases" aria-label="选择样例"></select> <select id="language" aria-label="压缩标记语言"><option value="zh-cn">压缩标记：中文</option><option value="en">Compaction label: English</option></select></header><div class="panels"><div><label>窄栏 · 300px</label><iframe id="sidecar" title="窄栏样例" sandbox="allow-scripts"></iframe></div><div id="detail-panel"><label>详情</label><iframe id="detail" title="详情样例" sandbox="allow-scripts"></iframe></div></div><script>const cases=${safe(cases)};const select=document.getElementById('cases'),language=document.getElementById('language'),sidecar=document.getElementById('sidecar'),detail=document.getElementById('detail'),detailPanel=document.getElementById('detail-panel');for(const c of cases.filter(c=>c.locale==='zh-cn')){const o=document.createElement('option');o.value=c.id;o.textContent=c.title;select.append(o)}let current;function showDetail(id){const html=current.details[id]||'';detailPanel.hidden=!html;detail.srcdoc=html}function show(){current=cases.find(c=>c.id===select.value&&c.locale===language.value);sidecar.srcdoc=current.sidecar;showDetail(current.detailId)}select.addEventListener('change',show);language.addEventListener('change',show);window.addEventListener('message',e=>{if(e.source!==sidecar.contentWindow||e.data?.caseId!==current.id||!Object.hasOwn(current.details,e.data.id))return;showDetail(e.data.id)});show();</script></html>`;
const target = resolve('.test-artifacts/presentation-gallery.html');
awaitMain();
async function awaitMain() { await mkdir(resolve('.test-artifacts'), { recursive: true }); await writeFile(target, html); console.log(target); }
