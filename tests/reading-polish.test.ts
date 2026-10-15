import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { summarizeShell, shellArgvScript } from '../packages/core/src/actions';
import { parseCodex } from '../packages/core/src/codex';
import { resolveOutlineEvidence } from '../packages/core/src/outline';
import { renderSidecar, renderInlineEvidence } from '../packages/vscode/src/render';
import { groupSessionTurns } from '../packages/core/src/timeline';
import { turnView } from '../packages/core/src/turn-view';
import { setLanguage } from '../packages/core/src/i18n';

// Written for the Chinese pages: their words are checked as they read in Chinese.
setLanguage('zh');
const response = (payload: unknown) => ({ type: 'response_item', payload });
const event = (payload: unknown) => ({ type: 'event_msg', payload });
const call = (input: string, id = 'wrapper') => response({ type: 'custom_tool_call', name: 'exec', call_id: id, input });
const native = (command: string, output: string, exit_code = 0, cwd = 'file:///fixture') => event({ type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', command], cwd, aggregated_output: output, exit_code } });
const parse = (...records: unknown[]) => parseCodex({ file: '/fixture/s.jsonl', projectPath: '/fixture', text: [event({ type: 'task_started', turn_id: 't' }), ...records].map(record => JSON.stringify(record)).join('\n') });
const doc = (data: ReturnType<typeof parse>) => new JSDOM(renderSidecar({ projectName: 'fixture', session: data, nonce: 't' })).window.document;

test('pipeline summaries retain search target and line limit; literal shell argv unwraps without losing quoting', () => {
  assert.equal(summarizeShell("rg -n 'follow|scroll' src/view.ts | head -20; git status --short"), '搜索代码 · follow|scroll · view.ts；取前 20 行；检查 Git 状态');
  assert.equal(summarizeShell("zsh -lc 'sed -n \"1,90p\" src/view.ts | tail -n 8'"), '读取 view.ts；取后 8 行');
  assert.equal(shellArgvScript(['/bin/zsh', '-lc', 'cat "a b.md"']), 'cat "a b.md"');
  assert.equal(shellArgvScript(['/bin/zsh', '-lc', 'cat a.md', 'extra']), undefined);
  assert.equal(summarizeShell("echo 'rg secrets | cat private'"), '输出文本 · rg secrets | cat private');
  assert.match(summarizeShell('zsh -lc "$SCRIPT"'), /动态参数/);
  assert.match(summarizeShell('cat "$(touch sentinel)" | head -5'), /动态参数/);
  assert.ok(!summarizeShell('rg "$PATTERN" src | head -5').includes('含管道'));
  assert.equal(summarizeShell("rg '<<' src | head -3"), '搜索代码 · << · src；取前 3 行');
  assert.equal(summarizeShell("cat > tests/view.ts <<'EOF'\nconst text = `it's ${literal}`;\nEOF"), "cat > tests/view.ts <<'EOF'");
});

test('exact native commands merge into their own inputs, preserve status, raw argv and wrapper output, with stable IDs', () => {
  const source = call('await tools.exec_command({cmd:"npm test"}); await tools.exec_command({cmd:"npm run build"});');
  const initial = doc(parse(source));
  const data = parse(source, native('npm test', 'test failed', 1), native('npm run build', 'build passed'), response({ type: 'custom_tool_call_output', call_id: 'wrapper', output: 'WRAPPER_EXTRA' }));
  const document = doc(data);
  const rows = [...document.querySelectorAll<HTMLElement>('.crow[data-tool="Bash"]')];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.getAttribute('data-status')), ['failed', 'info']);
  // The native records arriving later must not rename the rows (live morph keys and selection).
  const keys = (d: Document) => [...d.querySelectorAll('.crow-item')].map(row => row.getAttribute('data-observation-key'));
  // Existing rows keep their keys; the wrapper's extra output is a record of the calls and takes no row.
  assert.deepEqual(keys(document), keys(initial));
  assert.deepEqual(rows.map(row => row.dataset.itemId), [...initial.querySelectorAll<HTMLElement>('.crow[data-tool="Bash"]')].map(row => row.dataset.itemId));
  assert.equal(document.querySelector('.action-symbol'), null);
  const inline = new JSDOM(renderInlineEvidence(resolveOutlineEvidence(data, rows[0].dataset.itemId!)!)).window.document;
  assert.equal(inline.querySelectorAll('[data-io="input"]').length, 1);
  assert.match(inline.querySelector('[data-io="output"]')!.textContent!, /test failed/);
  assert.ok(!inline.querySelector('[data-io="output"]')!.textContent!.includes('build passed'));
  assert.equal(inline.querySelectorAll('.sources').length, 1);
  assert.match(inline.querySelectorAll('.sources')[0].textContent!, /WRAPPER_EXTRA/);
  assert.match(inline.querySelectorAll('.sources')[0].textContent!, /\/bin\/zsh/);
  assert.equal(inline.querySelector('.detail-state-line'), null);
  assert.equal(data.items.filter(item => item.commandInput).length, 2);
});

test('ambiguous, different cwd, cross-turn, completed and unmatched commands remain separate', () => {
  const source = call('await tools.exec_command({cmd:"npm test"});');
  const nativeTest = native('npm test', 'result');
  for (const records of [
    [source, call('await tools.exec_command({cmd:"npm test"});', 'other'), nativeTest],
    [source, native('npm test', 'result', 0, 'file:///other')],
    [source, event({ type: 'task_started', turn_id: 'other' }), nativeTest],
    [source, response({ type: 'custom_tool_call_output', call_id: 'wrapper', output: 'finished' }), nativeTest],
    [source, native('npm test --changed', 'different')],
  ]) assert.equal(parse(...records).items.filter(item => item.commandInput).length, 0);
  const repeated = parse(source, nativeTest, nativeTest);
  assert.equal(repeated.items.filter(item => item.commandInput).length, 1, 'one native event cannot consume the same input twice');
});

test('aggregated repeated reads retain each matched execution output', () => {
  const records = ['first', 'second'].flatMap(id => [call('await tools.exec_command({cmd:"cat a.ts"});', id), native('cat a.ts', `${id}_CONTENT`), response({ type: 'custom_tool_call_output', call_id: id, output: '' })]);
  const data = parse(...records), document = doc(data);
  const hosts = [...document.querySelectorAll<HTMLElement>('.crow[data-item-id]')];
  assert.equal(hosts.length, 1);
  assert.match(hosts[0].textContent!, /2 次/);
  const inline = new JSDOM(renderInlineEvidence(resolveOutlineEvidence(data, hosts[0].dataset.itemId!)!)).window.document;
  assert.deepEqual([...inline.querySelectorAll('[data-io="output"]')].map(output => output.textContent), ['first_CONTENT', 'second_CONTENT']);
});

test('shared OUT keeps extra wrapper text but elides only an exact repeated native result', () => {
  const source = call('await tools.exec_command({cmd:"npm test"}); await tools.exec_command({cmd:"npm run build"});');
  for (const [output, count] of [['first\nsecond', 0], ['first\nsecond\nextra', 1]] as const) {
    const data = parse(source, native('npm test', 'first'), native('npm run build', 'second'), response({ type: 'custom_tool_call_output', call_id: 'wrapper', output }));
    const rows = turnView(groupSessionTurns(data)[0], false, 'codex').rows.filter(row => row.output);
    assert.equal(rows.length, count);
    if (count) {
      const inline = new JSDOM(renderInlineEvidence(resolveOutlineEvidence(data, rows[0].id)!)).window.document;
      assert.equal(inline.querySelector('.detail-state-line'), null);
      assert.match(inline.querySelector('[data-io="output"]')!.textContent!, /extra/);
    }
    // The panel shows it as the terminal does: no row of its own.
    assert.equal(doc(data).querySelectorAll('.crow[data-tool="Output"], .crow[data-tool="OUT"]').length, 0);
  }
});
