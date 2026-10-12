import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudePlugins, codexPlugins, kitty, kittyRemote, KITTY_LINES, olderThan, setup, uninstall, SPLIT, STATE, type Report, type Runner } from '../packages/terminal/src/setup';
import { tempDir } from './temp';

const SOURCE = resolve(__dirname, '../..');

/** claude, codex and code as they answer, remembering what was installed. */
function agents(options: { vscode?: string; claude?: boolean; codex?: boolean; kitty?: boolean } = {}) {
  const claude = { markets: [] as string[], plugins: [] as string[] }, codex = { markets: [] as string[], plugins: [] as string[] };
  const calls: string[] = [];
  // Codex lists a marketplace under the name in its manifest, not the key it was added as.
  const codexNames: Record<string, string> = {};
  const ok = (out = '') => ({ ok: true, out });
  const run: Runner = (command, args) => {
    calls.push([command.split('/').pop(), ...args].join(' '));
    const sub = args.join(' ');
    if (command === 'claude') {
      if (options.claude === false) return { ok: false, out: '', missing: true };
      if (sub === 'plugin marketplace list --json') return ok(JSON.stringify(claude.markets.map(name => ({ name }))));
      if (sub === 'plugin list --json') return ok(JSON.stringify(claude.plugins.map(id => ({ id }))));
      if (sub.startsWith('plugin marketplace add')) { claude.markets.push('tickbird'); return ok(); }
      if (sub.startsWith('plugin marketplace remove')) { claude.markets = claude.markets.filter(name => name !== args[3]); return ok(); }
      if (args[1] === 'install') { claude.plugins.push(args[2]!); return ok(); }
      if (args[1] === 'uninstall') { claude.plugins = claude.plugins.filter(id => id !== args[2]); return ok(); }
      return ok();
    }
    if (command === 'codex') {
      if (options.codex === false) return { ok: false, out: '', missing: true };
      if (sub === 'plugin marketplace list --json') return ok(JSON.stringify({ marketplaces: codex.markets.map(name => ({ name: codexNames[name] ?? name })) }));
      if (sub === 'plugin list --json') return ok(JSON.stringify({ installed: codex.plugins.map(pluginId => ({ pluginId })), available: [] }));
      if (sub.startsWith('plugin marketplace add')) { codex.markets.push('tickbird'); return ok(); }
      if (sub.startsWith('plugin marketplace remove')) { codex.markets = codex.markets.filter(name => name !== args[3]); return ok(); }
      if (args[1] === 'add') { if (!codex.plugins.includes(args[2]!)) codex.plugins.push(args[2]!); return ok(); }
      if (args[1] === 'remove') { codex.plugins = codex.plugins.filter(id => id !== args[2]); return ok(); }
      return ok();
    }
    if (command.endsWith('code')) return options.vscode ? ok(`ms-python.python@1.0.0\nzchan0.tickbird@${options.vscode}`) : ok('ms-python.python@1.0.0');
    if (command === 'tmux') return ok('tmux 3.6a');
    if (command === 'kitty') return options.kitty === false ? { ok: false, out: '', missing: true } : ok('kitty 0.48.2');
    return { ok: false, out: '', missing: true };
  };
  return { run, calls, claude, codex, codexNames };
}

function collect(): Report & { lines: string[] } {
  const lines: string[] = [];
  const report = { lines, failed: false,
    ok: (what: string, note?: string) => { lines.push(`✓ ${what}${note ? '：' + note : ''}`); },
    fail: (what: string, note?: string) => { report.failed = true; lines.push(`✗ ${what}${note ? '：' + note : ''}`); },
    info: (text: string) => { lines.push(`· ${text}`); } };
  return report;
}

test('the earlier names go: their plugins and marketplace, even one Codex lists under the new name', () => {
  const machine = agents();
  machine.claude.markets.push('agent-sidecar'); machine.claude.plugins.push('sidecar-state@agent-sidecar', 'sidecar-split@agent-sidecar');
  // Added as agent-sidecar from this checkout, whose manifest now says tickbird.
  machine.codex.markets.push('agent-sidecar'); machine.codexNames['agent-sidecar'] = 'tickbird'; machine.codex.plugins.push('sidecar-state@agent-sidecar');
  assert.equal(claudePlugins(machine.run, SOURCE, [STATE, SPLIT], collect()), true);
  assert.equal(codexPlugins(machine.run, SOURCE, [STATE, SPLIT], collect()), true);
  assert.deepEqual(machine.claude, { markets: ['tickbird'], plugins: [STATE, SPLIT] });
  assert.deepEqual(machine.codex, { markets: ['tickbird'], plugins: [STATE, SPLIT] });
});

test('both plugins in both agents: installed the first time, brought up to date after', () => {
  const machine = agents();
  assert.equal(claudePlugins(machine.run, SOURCE, [STATE, SPLIT], collect()), true);
  assert.equal(codexPlugins(machine.run, SOURCE, [STATE, SPLIT], collect()), true);
  assert.deepEqual(machine.claude, { markets: ['tickbird'], plugins: [STATE, SPLIT] });
  assert.deepEqual(machine.codex, { markets: ['tickbird'], plugins: [STATE, SPLIT] });
  assert.ok(machine.calls.includes(`claude plugin marketplace add ${SOURCE}`));
  assert.ok(machine.calls.includes(`claude plugin install ${SPLIT} --scope user`));
  machine.calls.length = 0;
  claudePlugins(machine.run, SOURCE, [STATE, SPLIT], collect());
  codexPlugins(machine.run, SOURCE, [STATE, SPLIT], collect());
  assert.ok(machine.calls.includes('claude plugin marketplace update tickbird'), 'A known marketplace is refreshed, not added twice');
  assert.ok(machine.calls.includes(`claude plugin update ${STATE}`));
  assert.ok(!machine.calls.some(call => call.includes('marketplace add')));
  assert.deepEqual(machine.claude.plugins, [STATE, SPLIT], 'Nothing installed twice');
  // A missing agent is reported and skipped, never a crash.
  const report = collect();
  assert.equal(claudePlugins(agents({ claude: false }).run, SOURCE, [STATE], report), false);
  assert.match(report.lines[0]!, /没有找到 claude 命令/);
});

test('kitty.conf is read as kitty reads it: the last setting wins', () => {
  assert.deepEqual(kittyRemote(''), { remote: false, listen: false, splits: undefined });
  assert.deepEqual(kittyRemote('allow_remote_control socket-only\nlisten_on unix:/tmp/k\nenabled_layouts splits,stack'), { remote: true, listen: true, splits: true });
  assert.equal(kittyRemote('allow_remote_control yes\nallow_remote_control password').remote, false);
  assert.equal(kittyRemote('# allow_remote_control yes').remote, false, 'A comment is no setting');
  assert.equal(kittyRemote('enabled_layouts tall:bias=50,stack').splits, false);
  assert.equal(kittyRemote('listen_on tcp:localhost:1234').listen, false, 'Only a unix socket');
});

test('kitty.conf changes only when the reader says yes, backed up first, and only once', async () => {
  const dir = tempDir('kitty');
  const file = join(dir, 'kitty.conf');
  writeFileSync(file, 'font_size 13\nenabled_layouts splits,stack');
  const env = { KITTY_CONFIG_DIRECTORY: dir };
  let report = collect();
  await kitty(report, { env, ask: async () => false });
  assert.equal(readFileSync(file, 'utf8'), 'font_size 13\nenabled_layouts splits,stack', 'No means no change');
  assert.ok(report.lines.some(line => line.includes('allow_remote_control socket-only')), 'It says what to add');
  await kitty(collect(), { env });
  assert.equal(readFileSync(file, 'utf8'), 'font_size 13\nenabled_layouts splits,stack', 'Nobody to ask: no change');
  report = collect();
  await kitty(report, { env, ask: async () => true, now: new Date('2026-10-08T00:00:00Z') });
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith('font_size 13\nenabled_layouts splits,stack\n'), 'What was there stays');
  assert.ok(text.endsWith(KITTY_LINES.join('\n') + '\n'));
  assert.deepEqual(kittyRemote(text), { remote: true, listen: true, splits: true });
  const backups = readdirSync(dir).filter(name => name.startsWith('kitty.conf.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]!), 'utf8'), 'font_size 13\nenabled_layouts splits,stack');
  let asked = false;
  report = collect();
  await kitty(report, { env, ask: async () => { asked = true; return true; } });
  assert.equal(asked, false, 'Already on: nothing to ask');
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.ok(report.lines.includes('✓ kitty 远程控制：已开启'));
});

test('setup twice leaves the same machine, and says what is left to do', async () => {
  const data = tempDir('data');
  const kittyDir = tempDir('kitty');
  writeFileSync(join(data, 'install.json'), JSON.stringify({ source: SOURCE, version: '0.4.0' }));
  const machine = agents({ vscode: '0.2.0' });
  const options = { run: machine.run, paths: { data, bin: join(data, 'bin') }, env: { KITTY_CONFIG_DIRECTORY: kittyDir } };
  const first = collect();
  assert.equal(await setup({ ...options, report: first }), true);
  const after = JSON.stringify([machine.claude, machine.codex]);
  const second = collect();
  assert.equal(await setup({ ...options, report: second }), true);
  assert.equal(JSON.stringify([machine.claude, machine.codex]), after);
  for (const report of [first, second]) {
    assert.ok(report.lines.some(line => line.includes('Hooks need review')), 'Codex trust is explained');
    assert.ok(report.lines.some(line => line.includes('VS Code 版是 0.2.0')), 'An older VS Code version is pointed out');
    assert.ok(report.lines.some(line => line.includes('kitty 还没开启远程控制')));
  }
  const nowhere = collect();
  assert.equal(await setup({ ...options, paths: { data: join(data, 'none'), bin: data }, report: nowhere }), false);
  assert.match(nowhere.lines[0]!, /找不到插件来源/);
});

test('setup leaves kitty alone where kitty is not installed', async () => {
  const data = tempDir('data');
  writeFileSync(join(data, 'install.json'), JSON.stringify({ source: SOURCE, version: '0.4.0' }));
  const report = collect();
  let asked = false;
  await setup({ run: agents({ kitty: false }).run, report, paths: { data, bin: join(data, 'bin') }, kittyApp: join(data, 'no-kitty.app'),
    env: { KITTY_CONFIG_DIRECTORY: join(data, 'no-kitty') }, ask: async () => { asked = true; return true; } });
  assert.ok(!report.lines.some(line => line.includes('kitty')), report.lines.join('\n'));
  assert.equal(asked, false);
  assert.equal(existsSync(join(data, 'no-kitty', 'kitty.conf')), false);
});

test('uninstall removes the terminal version and keeps tickbird-state while VS Code uses it', async () => {
  for (const vscode of ['0.4.0', undefined]) {
    const data = tempDir('data');
    const bin = join(data, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tickbird'), '#!/bin/sh\n');
    writeFileSync(join(data, 'cli.cjs'), '');
    const machine = agents(vscode ? { vscode } : {});
    claudePlugins(machine.run, SOURCE, [STATE, SPLIT], collect());
    codexPlugins(machine.run, SOURCE, [STATE, SPLIT], collect());
    const report = collect();
    assert.equal(uninstall({ run: machine.run, report, paths: { data, bin } }), true);
    const left = vscode ? [STATE] : [];
    assert.deepEqual(machine.claude.plugins, left, vscode ? 'VS Code still reads the state files' : 'Nothing of Tickbird left');
    assert.deepEqual(machine.codex.plugins, left);
    assert.deepEqual(machine.claude.markets, vscode ? ['tickbird'] : []);
    assert.equal(existsSync(join(bin, 'tickbird')), false);
    assert.equal(existsSync(data), false);
  }
});

test('versions compare part by part', () => {
  assert.equal(olderThan('0.2.0', '0.4.0'), true);
  assert.equal(olderThan('0.10.0', '0.4.0'), false);
  assert.equal(olderThan('0.4.0', '0.4.0'), false);
});
