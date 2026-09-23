import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeExitPrefix, commandOutcome, exitReason } from '../packages/core/src/outcome';

test('only a single-stage search command reads exit 1 as an empty result', () => {
  assert.equal(commandOutcome('rg foo src', 1), 'empty');
  assert.equal(commandOutcome('/usr/bin/grep -q x f', 1), 'empty');
  assert.equal(commandOutcome("rg 'a|b' src", 1), 'empty', 'a pipe inside quotes is not a stage');
  // find exits 0 on no match, so its exit 1 is a real error
  assert.equal(commandOutcome('find . -name x', 1), 'failed');
  assert.equal(commandOutcome('false && rg foo', 1), 'failed');
  assert.equal(commandOutcome('ls; rg foo', 1), 'failed');
  assert.equal(commandOutcome('cat f | grep x', 1), 'failed');
  assert.equal(commandOutcome('rg foo src\nfalse', 1), 'failed', 'a newline separates commands');
  assert.equal(commandOutcome('rg foo', 2), 'failed');
  assert.equal(commandOutcome('npm test', 0), 'ok');
  assert.equal(commandOutcome('npm test', undefined), undefined, 'no recorded code, no verdict');
});

test('exit reasons decode only conventional codes and defer to the output otherwise', () => {
  assert.equal(exitReason(0), '');
  assert.equal(exitReason(127), '命令未找到');
  assert.equal(exitReason(126), '找到了但不可执行');
  assert.match(exitReason(130), /信号 2 SIGINT/);
  assert.match(exitReason(137), /信号 9 SIGKILL/);
  assert.match(exitReason(2), /用法或参数/);
  assert.match(exitReason(1), /看返回内容/);
});

test('the Claude exit prefix is read exactly, never guessed from other text', () => {
  assert.deepEqual(claudeExitPrefix('Error: Exit code 1\nboom'), { exitCode: 1, body: 'boom' });
  assert.deepEqual(claudeExitPrefix('Exit code 2\nusage'), { exitCode: 2, body: 'usage' }, 'content form, no prefix');
  assert.equal(claudeExitPrefix('Error: String to replace not found'), undefined);
  assert.equal(claudeExitPrefix('exit code 1'), undefined);
});
