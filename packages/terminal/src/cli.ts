#!/usr/bin/env node
import { NONE, probe, symbol, SYMBOLS, type Capabilities, type ProbeIO } from './caps';
import { describe, InputParser, type InputEvent } from './input';
import { watch } from './watch';
import { cutLine, enterBytes, leaveBytes, row, Screen, type Color, type Line, type Span } from './screen';

const ESCAPE_GAP_MS = 30;

function stdinIO(): ProbeIO {
  return {
    write: text => { process.stdout.write(text); },
    onData: listener => {
      const handler = (chunk: Buffer) => listener(chunk.toString('utf8'));
      process.stdin.on('data', handler);
      return () => { process.stdin.off('data', handler); };
    },
  };
}

async function detect(): Promise<Capabilities> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return NONE;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try { return await probe(stdinIO()); } finally { process.stdin.setRawMode(false); process.stdin.pause(); }
}

const yes = (value: unknown) => value ? '可用' : '不可用';

export function capsReport(caps: Capabilities, env: NodeJS.ProcessEnv = process.env): string {
  const bg = caps.background;
  const widths = Object.keys(SYMBOLS).map(ch => `${ch} ${caps.symbols[ch] ?? '?'}`).join('  ');
  return [
    `终端        ${caps.terminal ?? '(未回答)'}${caps.inTmux ? '  · 在 tmux 里' : ''}`,
    `TERM        ${env.TERM ?? '(未设置)'}`,
    `已探测      ${caps.probed ? '是' : '否（没有回答，全部按不支持处理）'}`,
    `防闪烁      ${yes(caps.sync)}`,
    `链接        ${yes(caps.links)}`,
    `图片        ${caps.images || '不可用'}`,
    `通知        ${caps.notify || '不可用'}`,
    `增强键盘    ${yes(caps.kittyKeyboard)}`,
    `剪贴板      ${yes(caps.clipboard)}`,
    `背景色      ${bg ? `rgb(${bg.r}, ${bg.g}, ${bg.b}) · ${bg.dark ? '深色' : '浅色'}` : '(未回答)'}`,
    `符号宽度    ${widths}`,
  ].join('\n');
}

async function caps(args: string[]): Promise<void> {
  const result = await detect();
  process.stdout.write(args.includes('--json') ? JSON.stringify(result, null, 2) + '\n' : capsReport(result) + '\n');
}

const PALETTE: Color[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** The demo picture: alignment of mixed text, the view symbols, the palette, and the last keys. */
export function demoLines(caps: Capabilities, width: number, height: number, keys: string[]): Line[] {
  const s = (ch: string) => symbol(caps, ch);
  const dim = { dim: true };
  const lines: Line[] = [
    row([{ text: ' Sidecar demo', style: { bold: true } }], [{ text: `${width}×${height} `, style: dim }], width),
    [{ text: ' 每行右端的 | 应该对齐成一列', style: dim }],
    '',
  ];
  for (const sample of ['Latin text only', '中文和 English 混排', '全角标点，句号。', 'emoji 🙂 two cells', 'code: `npm test`']) {
    lines.push(row([{ text: ` ${sample}` }], [{ text: '|', style: { fg: 'cyan' } }], Math.min(width, 32)));
  }
  lines.push('', [{ text: ' 符号', style: dim }]);
  lines.push([{ text: ' ' + Object.keys(SYMBOLS).map(s).join(' ') }]);
  lines.push([
    { text: ' ' }, { text: s('┃'), style: { fg: 'blue' } }, { text: ' 请求  ', style: { bold: true } },
    { text: s('●'), style: { fg: 'yellow' } }, { text: ' 运行中  ' },
    { text: s('⏸'), style: { fg: 'yellow' } }, { text: ' 等你批准  ' },
    { text: s('✻'), style: dim }, { text: ' 完成', style: dim },
  ]);
  lines.push('', [{ text: ' 16 色（跟随终端主题）', style: dim }]);
  for (const start of [0, 8]) {
    const swatches: Span[] = [{ text: start ? '  8–15 ' : '  0–7  ', style: dim }];
    for (const color of PALETTE.slice(start, start + 8)) swatches.push({ text: '  ', style: { bg: color } }, { text: ' ' });
    lines.push(swatches);
  }
  lines.push([
    { text: ' ' }, { text: 'bold', style: { bold: true } }, { text: ' ' }, { text: 'dim', style: dim }, { text: ' ' },
    { text: 'italic', style: { italic: true } }, { text: ' ' }, { text: 'underline', style: { underline: true } }, { text: ' ' },
    { text: 'link', style: { underline: true, link: 'https://example.com/sidecar' } },
  ]);
  lines.push('', [{ text: ' 按键回显（最新在上）', style: dim }]);
  const room = Math.max(0, height - lines.length - 2);
  for (const name of keys.slice(0, room)) lines.push(`   ${name}`);
  while (lines.length < height - 1) lines.push('');
  lines.push(row('', [{ text: 'q 退出   Ctrl+C 两次退出 ', style: dim }], width));
  return lines.slice(0, height).map(line => cutLine(line, width));
}

async function demo(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('demo 需要在终端里运行\n'); process.exitCode = 1; return; }
  const result = await detect();
  const screen = new Screen(process.stdout, result, process.stdout.columns, process.stdout.rows);
  const keys: string[] = [];
  const parser = new InputParser();
  let lastCtrlC = false, timer: NodeJS.Timeout | undefined;
  const draw = () => screen.render(demoLines(result, screen.width, screen.height, keys));
  const finish = () => {
    process.stdout.write(leaveBytes(result.kittyKeyboard));
    process.stdin.setRawMode(false);
    process.exit(0);
  };
  const handle = (events: InputEvent[]) => {
    for (const event of events) {
      if (event.type === 'mouse' && (event.action === 'release')) continue;
      keys.unshift(describe(event));
      keys.length = Math.min(keys.length, 50);
      if (event.type === 'key' && event.name === 'q' && !event.ctrl && !event.alt) finish();
      const ctrlC = event.type === 'key' && event.ctrl && event.name === 'c';
      if (ctrlC && lastCtrlC) finish();
      lastCtrlC = ctrlC;
    }
    draw();
  };
  process.stdout.write(enterBytes(result.kittyKeyboard));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', chunk => {
    if (timer) clearTimeout(timer);
    handle(parser.feed(chunk.toString('utf8')));
    if (parser.pending) timer = setTimeout(() => handle(parser.flush()), ESCAPE_GAP_MS);
  });
  process.stdout.on('resize', () => { screen.resize(process.stdout.columns, process.stdout.rows); draw(); });
  process.on('SIGTERM', finish);
  draw();
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === 'caps') return caps(args);
  if (command === 'demo') return demo();
  if (command === 'watch') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('watch 需要在终端里运行\n'); process.exitCode = 1; return; }
    return watch(args.find(arg => !arg.startsWith('-')), await detect());
  }
  process.stderr.write('用法：agent-sidecar watch [会话 ID 或记录文件] | caps [--json] | demo\n');
  process.exitCode = 2;
}

if (require.main === module) void main(process.argv.slice(2));
