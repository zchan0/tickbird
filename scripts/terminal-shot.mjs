#!/usr/bin/env node
// Screenshot of a kitty window, cell by cell: `kitten @ get-text --ansi` gives
// what is on screen with its colours, `kitten @ get-colors` the real palette.
// Every character is placed on its cell, so alignment in the picture is the
// terminal's alignment, not the browser font's.
//
//   node scripts/terminal-shot.mjs --to unix:/path/socket [--match id:1] --out shot.png [--title text] [--font family]
//   node scripts/terminal-shot.mjs --to … --out shot.png --capture-only     (fast: saves shot.capture.json only)
//   node scripts/terminal-shot.mjs --from shot.capture.json --out shot.png  (renders a saved capture)
//
// Capture-only takes a fraction of a second, so a live screen can be caught
// every second or two and rendered afterwards. Needs `npm run build` first.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { charWidth } = require(join(root, 'dist/packages/terminal/src/width.js'));

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']);
  return pairs;
}, []));
if ((!args.to && !args.from) || !args.out) { console.error('usage: terminal-shot.mjs (--to unix:SOCKET [--match id:N] | --from FILE.capture.json) --out FILE.png [--title TEXT] [--capture-only]'); process.exit(2); }
const out = resolve(args.out);

function capture() {
  const match = args.match ? ['--match', args.match] : [];
  const kitten = (...rest) => execFileSync('kitten', ['@', '--to', args.to, ...rest], { encoding: 'utf8' });
  const ansi = kitten('get-text', '--ansi', ...match);
  const palette = {};
  for (const line of kitten('get-colors', ...match).split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name && value?.startsWith('#')) palette[name] = value;
  }
  const windows = JSON.parse(kitten('ls', ...match)).flatMap(os => os.tabs.flatMap(tab => tab.windows));
  const window = windows.find(w => w.is_focused) ?? windows[0];
  return { ansi, palette, columns: window.columns, rows: window.lines, at: new Date().toISOString(), ...(args.title ? { title: args.title } : {}) };
}

const saved = args.from ? JSON.parse(readFileSync(args.from, 'utf8')) : capture();
if (!args.from) writeFileSync(out.replace(/\.png$/, '.capture.json'), JSON.stringify(saved));
if (args['capture-only']) { console.log(out.replace(/\.png$/, '.capture.json')); process.exit(0); }
const { ansi, palette, columns, rows } = saved;
const title = args.title ?? saved.title;

const color = index => palette[`color${index}`] ?? '#888';
const cube = n => {
  if (n < 16) return color(n);
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
};

// Applies one SGR parameter list (either ';' or ':' separated) to the pen.
function applySgr(pen, params) {
  const parts = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const sub = parts[i].split(':').map(Number);
    const code = sub[0];
    const extended = (target) => {
      // 38:5:n / 38:2::r:g:b / 38;5;n / 38;2;r;g;b
      if (sub.length > 1) {
        if (sub[1] === 5) pen[target] = cube(sub[2]);
        if (sub[1] === 2) { const [r, g, b] = sub.slice(-3); pen[target] = `rgb(${r},${g},${b})`; }
        return;
      }
      const mode = Number(parts[i + 1]);
      if (mode === 5) { pen[target] = cube(Number(parts[i + 2])); i += 2; }
      if (mode === 2) { pen[target] = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`; i += 4; }
    };
    if (code === 0) { for (const key of Object.keys(pen)) delete pen[key]; }
    else if (code === 1) pen.bold = true;
    else if (code === 2) pen.dim = true;
    else if (code === 3) pen.italic = true;
    else if (code === 4) pen.underline = sub[1] !== 0;
    else if (code === 7) pen.inverse = true;
    else if (code === 9) pen.strike = true;
    else if (code === 21 || code === 22) { pen.bold = false; pen.dim = false; }
    else if (code === 23) pen.italic = false;
    else if (code === 24) pen.underline = false;
    else if (code === 27) pen.inverse = false;
    else if (code === 29) pen.strike = false;
    else if (code >= 30 && code <= 37) pen.fg = color(code - 30);
    else if (code === 38) extended('fg');
    else if (code === 39) delete pen.fg;
    else if (code >= 40 && code <= 47) pen.bg = color(code - 40);
    else if (code === 48) extended('bg');
    else if (code === 49) delete pen.bg;
    else if (code >= 90 && code <= 97) pen.fg = color(code - 90 + 8);
    else if (code >= 100 && code <= 107) pen.bg = color(code - 100 + 8);
  }
}

const cells = [];
const pen = {};
let y = 0, x = 0;
for (let i = 0; i < ansi.length && y < rows;) {
  const rest = ansi.slice(i);
  const sgr = rest.match(/^\x1b\[([\d;:]*)m/);
  if (sgr) { applySgr(pen, sgr[1]); i += sgr[0].length; continue; }
  const osc = rest.match(/^\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/);
  if (osc) { if (osc[1] === '8') pen.link = Boolean(osc[2].split(';').slice(1).join(';')); i += osc[0].length; continue; }
  const other = rest.match(/^\x1b(?:\[[\d;:?<>=]*[\x20-\x2f]*[\x40-\x7e]|[^\[\]])/);
  if (other) { i += other[0].length; continue; }
  const char = String.fromCodePoint(ansi.codePointAt(i));
  i += char.length;
  if (char === '\n') { y++; x = 0; continue; }
  if (char === '\r') { x = 0; continue; }
  const width = charWidth(char.codePointAt(0));
  if (width === 0) continue;
  cells.push({ x, y, width, char, ...pen });
  x += width;
}

// The user's kitty font, so CJK and code look as they do on screen.
function kittyFont() {
  try {
    const conf = readFileSync(join(homedir(), '.config/kitty/kitty.conf'), 'utf8');
    return conf.match(/^\s*font_family\s+(.+?)\s*$/m)?.[1].replace(/\s+Regular$/, '');
  } catch { return undefined; }
}
const font = args.font ?? kittyFont();
const CW = 9, CH = 20, PAD = 14, TITLE = title ? 30 : 0;
const fg = palette.foreground ?? '#ddd', bg = palette.background ?? '#111';
const escape = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const spans = cells.map(cell => {
  let f = cell.fg ?? fg, b = cell.bg;
  if (cell.inverse) { [f, b] = [b ?? bg, f]; }
  const style = [`left:${cell.x * CW}px`, `top:${cell.y * CH}px`, `width:${cell.width * CW}px`, `color:${f}`];
  if (b) style.push(`background:${b}`);
  if (cell.dim) style.push(`color:color-mix(in srgb, ${f} 55%, ${b ?? bg})`);
  if (cell.bold) style.push('font-weight:700');
  if (cell.italic) style.push('font-style:italic');
  if (cell.underline || cell.link) style.push('text-decoration:underline');
  if (cell.strike) style.push('text-decoration:line-through');
  return `<span style="${style.join(';')}">${cell.char === ' ' ? '&nbsp;' : escape(cell.char)}</span>`;
}).join('');

const width = columns * CW + PAD * 2, height = rows * CH + PAD * 2 + TITLE;
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${bg}}
.title{height:${TITLE}px;line-height:${TITLE}px;padding:0 ${PAD}px;font:12px -apple-system,'PingFang SC',sans-serif;color:${fg};opacity:.6;border-bottom:1px solid color-mix(in srgb, ${fg} 15%, ${bg})}
.grid{position:relative;margin:${PAD}px;width:${columns * CW}px;height:${rows * CH}px;font:15px/${CH}px ${font ? `'${font}',` : ''}Menlo,'SF Mono','PingFang SC',monospace}
.grid span{position:absolute;height:${CH}px;text-align:center;white-space:pre}
</style>${TITLE ? `<div class="title">${escape(title)}</div>` : ''}<div class="grid">${spans}</div>`;

const work = mkdtempSync(join(tmpdir(), 'shot-'));
const page = join(work, 'shot.html');
writeFileSync(page, html);
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
rmSync(out, { force: true });
// Headless Chrome often stays up after it saved the picture: stop it once the file is complete.
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(work, 'profile')}`,
  '--force-device-scale-factor=2', `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${page}`], { stdio: 'ignore' });
const started = Date.now();
let size = -1;
while (Date.now() - started < 15000) {
  await new Promise(done => setTimeout(done, 150));
  const now = existsSync(out) ? statSync(out).size : -1;
  if (now > 0 && now === size) break;
  size = now;
  if (child.exitCode !== null) break;
}
child.kill('SIGKILL');
rmSync(work, { recursive: true, force: true });
if (!existsSync(out)) { console.error('Chrome wrote no screenshot'); process.exit(1); }
console.log(`${out}  (${columns}×${rows})`);
