import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFrom, NONE, parseAnswers, probe, queries, symbol, SYMBOLS, type ProbeIO } from '../packages/terminal/src/caps';
import { capsReport, demoLines } from '../packages/terminal/src/cli';
import { describe, InputParser } from '../packages/terminal/src/input';
import { clipboardBytes, editorArgs, editorCommand } from '../packages/terminal/src/effects';
import { encodeLine, plainText, row, Screen } from '../packages/terminal/src/screen';
import { clean, fit, textWidth, wrap } from '../packages/terminal/src/width';

// Strips SGR and OSC 8 so the visible cells can be measured.
const visible = (bytes: string) => bytes.replace(/\x1b\[[\d;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');

test('cell width counts CJK and emoji as two and drops controls', () => {
  assert.equal(textWidth('abc'), 3);
  assert.equal(textWidth('中文'), 4);
  assert.equal(textWidth('✻ 好'), 4);
  assert.equal(clean('a\x1b]52;c;ZXZpbA==\x07b\x1b[2Jc'), 'a]52;c;ZXZpbA==b[2Jc');
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(clean('x\u0007\u009b31my\u0000')));
  assert.equal(fit('一二三四五', 6), '一二…');
  assert.ok(textWidth(fit('一二三四五', 6)) <= 6);
});

test('wrapping fills CJK lines, keeps Latin words whole and never starts a line with closing punctuation', () => {
  for (const line of wrap('接口都明确了：`chapterTurn` 可以直接复用，只需加 export 引用而不复制。', 20)) assert.ok(textWidth(line) <= 20, line);
  assert.deepEqual(wrap('hello wonderful world', 12), ['hello', 'wonderful', 'world']);
  const lines = wrap('一二三四五六七八九，十', 18);
  assert.ok(lines.every(line => !/^[，。、]/.test(line)), JSON.stringify(lines));
  assert.deepEqual(wrap('这是一个很长的中文句子 core 后面还有字', 24), ['这是一个很长的中文句子', 'core 后面还有字']);
  assert.deepEqual(wrap('可以直接 core 中直接复用这些函数', 12), ['可以直接', 'core 中直接', '复用这些函数']);
  // A Latin word right after CJK punctuation also moves whole.
  assert.deepEqual(wrap('苹果、banana、cherry', 12), ['苹果、', 'banana、', 'cherry']);
  // Closing marks after a word take the word along: no line starts with ")。".
  assert.deepEqual(wrap('详细数据见库存系统 (https://example.com/inventory)。', 36), ['详细数据见库存系统', '(https://example.com/inventory)。']);
  // A URL is one word.
  assert.deepEqual(wrap('第二步，运行 curl https://example.com 检查', 24), ['第二步，运行 curl', 'https://example.com 检查']);
});

test('an encoded row is exactly the pane width, never splits a wide character, and drops escapes from text', () => {
  for (const width of [1, 5, 6, 7, 40]) {
    const bytes = encodeLine([{ text: '中文和 English', style: { bold: true } }, { text: ' 混排', style: { fg: 'cyan' } }], width);
    assert.equal(textWidth(visible(bytes)), width, `${width}: ${JSON.stringify(bytes)}`);
  }
  // Width 5: "中文" is 4 cells, "和" would cross the edge, so a space fills the last cell.
  assert.equal(visible(encodeLine('中文和', 5)), '中文 ');
  const hostile = encodeLine('ok\x1b[2J\x1b]52;c;ZXZpbA==\x07', 30);
  assert.ok(!hostile.includes('\x1b[2J') && !hostile.includes('\x1b]52'), JSON.stringify(hostile));
});

test('links are drawn only when the terminal shows them', () => {
  const line = [{ text: 'render.ts', style: { link: 'file:///x/render.ts' } }];
  assert.ok(encodeLine(line, 20, true).includes('\x1b]8;;file:///x/render.ts\x1b\\render.ts\x1b]8;;\x1b\\'));
  assert.ok(!encodeLine(line, 20, false).includes('\x1b]8'));
});

test('a row puts its right part flush right and cuts the left part first', () => {
  const wide = row('Claude Code · 插件按功能拆分', '● 运行中', 40);
  assert.equal(textWidth(plainText(wide)), 40);
  assert.ok(plainText(wide).endsWith('● 运行中'));
  const narrow = row('Claude Code · 插件按功能拆分并改名', '● 运行中', 20);
  assert.ok(textWidth(plainText(narrow)) <= 20, plainText(narrow));
  assert.ok(plainText(narrow).endsWith('● 运行中') && plainText(narrow).includes('…'), plainText(narrow));
});

test('the screen writes only the rows that changed, inside a synchronized frame when supported', () => {
  const out: string[] = [];
  const screen = new Screen({ write: text => out.push(text) }, { sync: true, links: false }, 10, 3);
  screen.render(['one', 'two', 'three']);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('\x1b[?2026h') && out[0].endsWith('\x1b[?2026l'));
  assert.ok(out[0].includes('\x1b[2J') && out[0].includes('\x1b[1;1H') && out[0].includes('\x1b[3;1H'));
  screen.render(['one', 'two', 'three']);
  assert.equal(out.length, 1, 'An unchanged frame writes nothing');
  screen.render(['one', 'TWO', 'three']);
  assert.equal(out.length, 2);
  assert.ok(out[1].includes('\x1b[2;1H') && !out[1].includes('\x1b[1;1H') && !out[1].includes('\x1b[3;1H') && !out[1].includes('\x1b[2J'), JSON.stringify(out[1]));
  // A resize forgets what is shown, so the next frame clears and redraws every row.
  screen.resize(8, 2);
  screen.render(['one', 'TWO']);
  assert.ok(out[2].includes('\x1b[2J') && out[2].includes('\x1b[1;1H') && out[2].includes('\x1b[2;1H'));
  const plain = new Screen({ write: text => out.push(text) }, { sync: false, links: false }, 10, 1);
  plain.render(['x']);
  assert.ok(!out[3].includes('\x1b[?2026'));
});

test('input: legacy keys, the kitty keyboard protocol and modifiers', () => {
  const parse = (text: string) => new InputParser().feed(text).map(describe);
  assert.deepEqual(parse('\x1b[A\x1b[B\x1bOA\r\x03q '), ['↑', '↓', '↑', '⏎', 'Ctrl+c', 'q', 'Space']);
  assert.deepEqual(parse('\x1bx\x1b[1;5A\x1b[5~\x1b[Z\x7f\t'), ['Alt+x', 'Ctrl+↑', 'PgUp', 'Shift+Tab', '⌫', 'Tab']);
  // kitty: Esc, Alt+x, Ctrl+c, Shift+a and Ctrl+Enter each arrive as CSI code;mods u.
  assert.deepEqual(parse('\x1b[27u\x1b[120;3u\x1b[99;5u\x1b[97;2u\x1b[13;5u'), ['Esc', 'Alt+x', 'Ctrl+c', 'A', 'Ctrl+⏎']);
  assert.deepEqual(parse('中a'), ['中', 'a']);
});

test('input: a lone Esc waits for more, then reads as Escape; a split sequence joins up', () => {
  const parser = new InputParser();
  assert.deepEqual(parser.feed('\x1b'), []);
  assert.ok(parser.pending);
  assert.deepEqual(parser.flush().map(describe), ['Esc']);
  assert.deepEqual(parser.feed('\x1b['), []);
  assert.deepEqual(parser.feed('1;5'), []);
  assert.deepEqual(parser.feed('B').map(describe), ['Ctrl+↓']);
  assert.ok(!parser.pending);
});

test('input: SGR mouse and late terminal replies', () => {
  const events = new InputParser().feed('\x1b[<0;12;4M\x1b[<0;12;4m\x1b[<64;3;9M\x1b[<65;3;9M');
  assert.deepEqual(events, [
    { type: 'mouse', action: 'press', button: 0, x: 12, y: 4 },
    { type: 'mouse', action: 'release', button: 0, x: 12, y: 4 },
    { type: 'mouse', action: 'wheelUp', button: 64, x: 3, y: 9 },
    { type: 'mouse', action: 'wheelDown', button: 65, x: 3, y: 9 },
  ]);
  // A reply that arrives after the probe gave up is skipped, not typed.
  assert.deepEqual(new InputParser().feed('\x1b]11;rgb:0000/0000/0000\x1b\\\x1bP>|kitty(0.43)\x1b\\\x1b_Gi=31;OK\x1b\\\x1b]99;x\x07j').map(describe), ['j']);
  assert.deepEqual(new InputParser().feed('\x1b[?62;c\x1b[?2026;2$yk').map(describe), ['k']);
});

const KITTY_REPLY = '\x1b[?2026;2$y\x1b[?0u\x1b_Gi=31;OK\x1b\\\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\\x1bP>|kitty(0.43.1)\x1b\\'
  + '\x1b]99;i=sidecar:p=?;a=focus,report:o=always,unfocused:u=0,1,2:p=title,body\x1b\\\x1bP1+r4d73=5c45\x1b\\'
  + Object.keys(SYMBOLS).map(() => '\x1b[5;2R').join('') + '\x1b[?62;52;c';
// Recorded from tmux 3.6a (default config) inside kitty: only the background, its version, cursor reports and DA1.
const TMUX_REPLY = '\x1b]11;rgb:1616/1a1a/2020\x1b\\\x1bP>|tmux 3.6a\x1b\\' + Object.keys(SYMBOLS).map(() => '\x1b[1;2R').join('') + '\x1b[?1;2;4c';

function fakeTerminal(reply: string | undefined, chunks = 3, delayMs = 1): ProbeIO & { written: string[] } {
  const written: string[] = [];
  let listener: ((text: string) => void) | undefined;
  return {
    written,
    write(text) {
      written.push(text);
      if (reply === undefined) return;
      // The reply comes back in pieces, as it does over a real tty.
      const size = Math.ceil(reply.length / chunks);
      for (let start = 0; start < reply.length; start += size) {
        const piece = reply.slice(start, start + size);
        setTimeout(() => listener?.(piece), delayMs);
      }
    },
    onData(next) { listener = next; return () => { listener = undefined; }; },
  };
}

test('probing kitty finds every enhancement and one-cell symbols', async () => {
  const io = fakeTerminal(KITTY_REPLY);
  const caps = await probe(io, { TERM: 'xterm-kitty' }, 500);
  assert.equal(io.written.join(''), queries());
  assert.deepEqual({ ...caps, symbols: undefined }, {
    probed: true, sync: true, links: true, images: 'kitty', notify: 'osc99', kittyKeyboard: true, clipboard: true,
    background: { r: 30, g: 30, b: 46, dark: true }, terminal: 'kitty(0.43.1)', inTmux: false, symbols: undefined,
  });
  assert.ok(Object.keys(SYMBOLS).every(ch => caps.symbols[ch] === 1));
  assert.equal(symbol(caps, '●'), '●');
});

test('a terminal that answers late is still probed: kitty in the background takes about 190ms', async () => {
  const started = Date.now();
  const caps = await probe(fakeTerminal(KITTY_REPLY, 3, 200), { TERM: 'xterm-kitty' });
  assert.equal(caps.probed, true);
  assert.equal(caps.images, 'kitty');
  assert.ok(Date.now() - started < 500, 'The wait ends at DA1, not at the limit');
});

test('probing inside tmux: no images or notifications, links only when tmux forwards them', async () => {
  const env = { TERM: 'tmux-256color', TMUX: '/tmp/tmux-501/default,1,0' };
  const io = fakeTerminal(TMUX_REPLY);
  const caps = await probe(io, env, 500, () => 'xterm*:clipboard:ccolour:cstyle:focus:title\n');
  // tmux would show an APC query as the pane title, so none is sent.
  assert.ok(!io.written.join('').includes('\x1b_'), JSON.stringify(io.written));
  assert.equal(caps.probed, true);
  assert.equal(caps.inTmux, true);
  assert.equal(caps.images, false);
  assert.equal(caps.notify, false);
  assert.equal(caps.links, false);
  assert.equal(caps.kittyKeyboard, false);
  assert.equal(caps.sync, false);
  assert.equal(caps.terminal, 'tmux 3.6a');
  const linked = await probe(fakeTerminal(TMUX_REPLY), env, 500, () => 'xterm*:clipboard:hyperlinks\n');
  assert.equal(linked.links, true);
});

test('a terminal that never answers is treated as supporting nothing after the timeout', async () => {
  const started = Date.now();
  const caps = await probe(fakeTerminal(undefined), { TERM: 'xterm-256color' }, 60);
  assert.ok(Date.now() - started >= 55);
  assert.equal(caps.probed, false);
  assert.equal(caps.sync, false);
  assert.equal(caps.images, false);
  assert.deepEqual(caps.symbols, {});
  assert.equal(symbol(caps, '●'), '*', 'Unmeasured symbols fall back to ASCII');
});

test('TERM=dumb sends no query at all', async () => {
  const io = fakeTerminal(KITTY_REPLY);
  assert.deepEqual(await probe(io, { TERM: 'dumb' }), NONE);
  assert.deepEqual(io.written, []);
});

test('a symbol measured at two cells falls back to ASCII', () => {
  const answers = parseAnswers('\x1b[5;3R\x1b[5;2R\x1b[?62c');
  const caps = capabilitiesFrom(answers, { TERM: 'xterm' }, ['⏸', '●']);
  assert.deepEqual(caps.symbols, { '⏸': 2, '●': 1 });
  assert.equal(symbol(caps, '⏸'), '||');
  assert.equal(symbol(caps, '●'), '●');
});

test('the caps report names every capability', () => {
  const report = capsReport(NONE, { TERM: 'dumb' });
  for (const label of ['防闪烁', '链接', '图片', '通知', '增强键盘', '剪贴板', '背景色', '符号宽度']) assert.ok(report.includes(label), label);
  assert.ok(report.includes('否（没有回答'));
});

test('every demo line fits the pane at any width', async () => {
  const caps = await probe(fakeTerminal(KITTY_REPLY), { TERM: 'xterm-kitty' }, 500);
  for (const [width, height] of [[24, 12], [40, 30], [62, 30], [120, 40]]) {
    const lines = demoLines(caps, width, height, ['↑', 'Alt+x', 'Ctrl+c']);
    assert.equal(lines.length, height);
    for (const line of lines) assert.ok(textWidth(plainText(line)) <= width, `${width}: ${plainText(line)}`);
  }
});

test('o picks $VISUAL, then $EDITOR, then VS Code, then the system opener, each with its own line syntax', () => {
  const none = () => false, code = (command: string) => command === 'code';
  assert.deepEqual(editorCommand('/p/a.ts', 12, { VISUAL: 'nvim', EDITOR: 'nano' }, code), { command: 'nvim', args: ['+12', '/p/a.ts'], inPane: true, name: 'nvim' });
  assert.deepEqual(editorCommand('/p/a.ts', 12, { EDITOR: 'code --wait' }, none), { command: 'code', args: ['--wait', '-g', '/p/a.ts:12'], inPane: false, name: 'code' });
  assert.deepEqual(editorCommand('/p/a.ts', 12, {}, code), { command: 'code', args: ['-g', '/p/a.ts:12'], inPane: false, name: 'VS Code' });
  assert.deepEqual(editorCommand('/p/a.ts', 12, {}, none, 'darwin'), { command: 'open', args: ['/p/a.ts'], inPane: false, name: '系统默认程序' });
  assert.deepEqual(editorCommand('/p/a.ts', 12, {}, none, 'linux').command, 'xdg-open');
  assert.deepEqual(editorArgs('/usr/local/bin/subl', '/p/a.ts', 3), ['/p/a.ts:3']);
  assert.deepEqual(editorArgs('unknown-editor', '/p/a.ts', 3), ['/p/a.ts']);
});

test('y writes OSC 52 with the text in base64', () => {
  assert.equal(clipboardBytes('npm test'), '\x1b]52;c;bnBtIHRlc3Q=\x1b\\');
  assert.equal(Buffer.from(clipboardBytes('路径').slice(7, -2), 'base64').toString(), '路径');
});
