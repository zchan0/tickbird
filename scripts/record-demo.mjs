#!/usr/bin/env node
// The README's pictures, drawn from the made-up session in demo/session.mjs:
//   docs/images/demo.gif     the agent's pane on the left, Tickbird's on the right, one turn from ask to answer
//   docs/images/vscode.png   the same turn in the VS Code side bar
// Tickbird's side is the real pane: the session is replayed into the app's own
// frame() with its motion, ten frames a second. The agent's side is drawn as
// Claude Code draws each step. Frames are taken with headless Chrome and put
// together with ffmpeg.
//
//   npm run record-demo
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT, START, STEPS, transcript } from '../demo/session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dist = path => require(join(root, 'dist', path));
const { parseClaude } = dist('packages/core/src/claude.js');
const { visibleTurnGroups } = dist('packages/core/src/outline.js');
const { turnView } = dist('packages/core/src/turn-view.js');
const { SYMBOLS } = dist('packages/terminal/src/caps.js');
const { frame, initialState, update } = dist('packages/terminal/src/app.js');
const { Motion } = dist('packages/terminal/src/motion.js');
const { sessionStatus } = dist('packages/terminal/src/views/turn-page.js');
const { wrapSpans } = dist('packages/terminal/src/views/prose.js');
const { spans, cutLine } = dist('packages/terminal/src/screen.js');
const { charWidth } = dist('packages/terminal/src/width.js');
const { renderSidecar } = dist('packages/vscode/src/render.js');
// The README's pictures are in English.
dist('packages/core/src/i18n.js').setLanguage('en');

const FPS = 10, END = 13300, HOLD = 3500;
const LEFT = 62, RIGHT = 48, ROWS = 32, CW = 9, CH = 20, PAD = 16, TITLE = 30;
// A dark terminal theme; Tickbird mixes its greys from the background and the text colour, as it does from a real terminal's.
const PALETTE = { background: '#17191e', foreground: '#c8ccd4', black: '#2b2f37', red: '#e5787f', green: '#8fc27e', yellow: '#dcb56e', blue: '#6fa8dc', magenta: '#c49be0', cyan: '#6cc0c6', white: '#c8ccd4',
  brightBlack: '#6b717c', brightRed: '#ef8f95', brightGreen: '#a5d493', brightYellow: '#e8c787', brightBlue: '#8bbbe6', brightMagenta: '#d3b0eb', brightCyan: '#85cfd4', brightWhite: '#e6e8ec' };
const hex = value => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16));
const [br, bg, bb] = hex(PALETTE.background), [fr, fg, fb] = hex(PALETTE.foreground);
const caps = { links: false, symbols: Object.fromEntries(Object.keys(SYMBOLS).map(ch => [ch, 1])), background: { r: br, g: bg, b: bb, dark: true }, foreground: { r: fr, g: fg, b: fb } };

// --- Tickbird's pane: the app itself, fed the transcript as it grows. ---
const motion = new Motion();
let app = initialState(), frames = 0;
function tickbird(at) {
  const records = transcript(at);
  const session = parseClaude({ file: '/demo/session.jsonl', projectPath: PROJECT, text: records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '') });
  const groups = visibleTurnGroups(session);
  const now = Date.parse(START) + at;
  const status = sessionStatus(groups.length ? turnView(groups.at(-1), true, 'claude') : undefined, {}, now, { busy: at >= 600 && at < END, state: at >= 600 && at < END ? 'busy' : 'idle' });
  const model = { session, groups, status, extras: {}, caps, now, width: RIGHT, height: ROWS, motion, frame: frames++ };
  app = update(app, model);
  const lines = frame(app, model);
  // The first page is drawn still; what comes after moves in, as in the pane.
  motion.live = true;
  return lines;
}

// --- The agent's pane: each step whole when it comes, as Claude Code draws it. ---
const GREY = { fg: 'brightBlack' };
function agent(at) {
  const lines = [];
  const wrap = (text, style = {}, lead = '  ', first = lead) => wrapSpans([{ text, style }], LEFT - lead.length - 1).forEach((part, index) => lines.push([{ text: index ? lead : first }, ...spans(part)]));
  const results = new Map(STEPS.filter(step => step.result && step.at <= at).map(step => [step.result, step]));
  for (const step of STEPS.filter(step => step.at <= at)) {
    if (step.user) { wrap(step.user, {}, '  ', '> '); lines.push([]); }
    else if (step.say || step.answer) {
      const text = (step.say ?? step.answer).replace(/`/g, '');
      text.split('\n').filter(Boolean).forEach((paragraph, index) => wrap(paragraph, {}, paragraph.startsWith('- ') ? '    ' : '  ', index ? (paragraph.startsWith('- ') ? '  ' : '  ') : '⏺ '));
      lines.push([]);
    } else if (step.call) {
      const result = results.get(step.call);
      const name = { Edit: 'Update', Write: 'Write', Read: 'Read', Bash: 'Bash' }[step.tool];
      const what = step.input.command ?? step.input.file_path.replace(PROJECT + '/', '');
      const dot = !result ? { fg: 'brightBlack' } : result.error ? { fg: 'red' } : { fg: 'green' };
      lines.push([{ text: '⏺ ', style: dot }, { text: name, style: { bold: true } }, { text: `(${what})` }]);
      if (!result) lines.push([{ text: '  ⎿  ', style: GREY }, { text: 'Running…', style: GREY }]);
      else (result.screen ?? []).forEach((text, index) => lines.push(cutLine([{ text: index ? '     ' : '  ⎿  ', style: GREY },
        { text, style: text.startsWith('+') ? { fg: 'green' } : text.startsWith('-') ? { fg: 'red' } : result.error && index === 0 ? { fg: 'red' } : GREY }], LEFT - 1)));
      lines.push([]);
    }
  }
  // Working: the spinner under what it has drawn.
  if (at >= 600 && at < END) lines.push([{ text: '✻ ', style: { fg: 'yellow' } }, { text: 'Working…', style: GREY }]);
  // The input line at the bottom between two rules, the conversation scrolling above it.
  const rule = [{ text: '\u2500'.repeat(LEFT - 1), style: GREY }];
  const box = [rule, [{ text: '> ', style: GREY }], rule];
  const room = ROWS - box.length;
  return [...lines.slice(Math.max(0, lines.length - room)), ...Array(Math.max(0, room - lines.length)).fill([]), ...box];
}

// --- One frame as HTML: every character on its cell, as terminal-shot.mjs draws a capture. ---
const css = style => {
  const color = name => name && PALETTE[name];
  let fgc = style?.fgRgb ? `rgb(${style.fgRgb.join(',')})` : color(style?.fg) ?? PALETTE.foreground;
  let bgc = style?.bgRgb ? `rgb(${style.bgRgb.join(',')})` : color(style?.bg);
  if (style?.dim && (!style.fg || style.fg === 'default')) fgc = PALETTE.brightBlack;
  if (style?.inverse) [fgc, bgc] = [bgc ?? PALETTE.background, fgc];
  return [`color:${fgc}`, bgc ? `background:${bgc}` : '', style?.bold ? 'font-weight:700' : '', style?.underline ? 'text-decoration:underline' : '', style?.italic ? 'font-style:italic' : ''].filter(Boolean).join(';');
};
function pane(lines, left) {
  let html = '';
  lines.slice(0, ROWS).forEach((line, y) => {
    let x = 0;
    for (const span of spans(line)) {
      const style = css(span.style);
      for (const char of span.text) {
        const width = charWidth(char.codePointAt(0));
        if (!width) continue;
        if (char !== ' ' || /background/.test(style)) html += `<i style="left:${left + x * CW}px;top:${y * CH}px;width:${width * CW}px;${style}">${char === ' ' ? '&nbsp;' : char.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</i>`;
        x += width;
      }
    }
  });
  return html;
}
const WIDTH = (LEFT + 1 + RIGHT) * CW + PAD * 2, HEIGHT = ROWS * CH + PAD * 2 + TITLE;
const divider = `<b style="left:${LEFT * CW + CW / 2}px"></b>`;
const page = frames => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${PALETTE.background}}
.bar{height:${TITLE}px;display:flex;font:12px -apple-system,'PingFang SC',sans-serif;color:${PALETTE.foreground};border-bottom:1px solid #2a2e36}
.bar span{opacity:.55;line-height:${TITLE}px;padding-left:${PAD}px}
.grid{position:relative;margin:${PAD}px;height:${ROWS * CH}px;font:15px/${CH}px Menlo,'SF Mono','PingFang SC',monospace}
.grid i{position:absolute;height:${CH}px;text-align:center;white-space:pre;font-style:normal}
.grid b{position:absolute;top:-${PAD}px;bottom:-${PAD}px;width:1px;background:#2a2e36}
</style><div class="bar"><span style="width:${LEFT * CW + PAD}px">claude — ~/wordcount</span><span>tickbird</span></div><div class="grid" id="grid"></div>
<script>const frames = ${JSON.stringify(frames)}; function show(n) { document.getElementById('grid').innerHTML = frames[n]; }</script>`;

// --- Headless Chrome, driven over its DevTools protocol (Node's own WebSocket). ---
async function chrome(work) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let tries = 0; !target && tries < 50; tries++) {
    await new Promise(done => setTimeout(done, 200));
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(entry => entry.type === 'page'); } catch { /* Not up yet. */ }
  }
  if (!target) { child.kill('SIGKILL'); throw new Error('Chrome did not start'); }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const waiting = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } };
  const send = (method, params = {}) => new Promise((done, fail) => { const at = ++id; waiting.set(at, message => message.error ? fail(new Error(message.error.message)) : done(message.result)); socket.send(JSON.stringify({ id: at, method, params })); });
  return { send, close: () => { socket.close(); child.kill('SIGKILL'); } };
}
async function load(browser, file, width, height, scale) {
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await browser.send('Page.enable');
  await browser.send('Page.navigate', { url: pathToFileURL(file).href });
  await new Promise(done => setTimeout(done, 800));
}
const shot = async (browser, out) => writeFileSync(out, Buffer.from((await browser.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// --- The GIF. ---
const work = mkdtempSync(join(tmpdir(), 'tickbird-demo-'));
const images = join(root, 'docs', 'images');
mkdirSync(images, { recursive: true });
const html = [];
for (let at = 0; at <= END + HOLD; at += 1000 / FPS) html.push(pane(agent(at), 0) + pane(tickbird(at), (LEFT + 1) * CW) + divider);
writeFileSync(join(work, 'frames.html'), page(html));
const browser = await chrome(work);
try {
  await load(browser, join(work, 'frames.html'), WIDTH, HEIGHT, 1);
  for (let n = 0; n < html.length; n++) {
    await browser.send('Runtime.evaluate', { expression: `show(${n})` });
    await shot(browser, join(work, `f${String(n).padStart(4, '0')}.png`));
  }
  console.log(`✓ ${html.length} 帧`);

  // The VS Code side bar, the turn over, in VS Code's dark theme.
  const records = transcript(Infinity);
  const session = parseClaude({ file: '/demo/session.jsonl', projectPath: PROJECT, text: records.map(record => JSON.stringify(record)).join('\n') + '\n' });
  const nonce = 'demo';
  const theme = `<style nonce="${nonce}">:root{--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;--vscode-descriptionForeground:#9d9d9d;--vscode-editorWarning-foreground:#cca700;--vscode-errorForeground:#f85149;--vscode-charts-green:#89d185;--vscode-panel-border:#2b2b2b;--vscode-textCodeBlock-background:#2b2b2b;--vscode-textLink-foreground:#4daafc;--vscode-list-hoverBackground:#2a2d2e;--vscode-font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace}</style>`;
  const stub = `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});</script>`;
  writeFileSync(join(work, 'vscode.html'), renderSidecar({ projectName: 'wordcount', session, nonce }).replace('<head>', '<head>' + theme + stub));
  await load(browser, join(work, 'vscode.html'), 380, 820, 2);
  await shot(browser, join(images, 'vscode.png'));
  console.log('✓ docs/images/vscode.png');
} finally { browser.close(); }

const ffmpeg = (...args) => { const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }); if (result.status !== 0) throw new Error('ffmpeg failed'); };
const input = ['-framerate', String(FPS), '-i', join(work, 'f%04d.png')];
ffmpeg(...input, '-vf', 'palettegen=stats_mode=diff:max_colors=128', join(work, 'palette.png'));
ffmpeg(...input, '-i', join(work, 'palette.png'), '-lavfi', 'paletteuse=dither=none:diff_mode=rectangle', '-gifflags', '+transdiff', join(images, 'demo.gif'));
console.log('✓ docs/images/demo.gif');
rmSync(work, { recursive: true, force: true });
