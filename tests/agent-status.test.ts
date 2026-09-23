import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRunState, claudeSessionsDirectory } from '../packages/core/src/agent-status';

test('Claude Code\'s own busy/idle is read for the attached session only, and only from a living process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidecar-claude-home-'));
  const transcript = join(home, 'projects', '-fixture', 'session-a.jsonl');
  assert.equal(claudeSessionsDirectory(transcript), join(home, 'sessions'));
  const read = claudeRunState(transcript, 'session-a');
  assert.equal(await read(), undefined, 'No registry: nothing is claimed');
  await mkdir(join(home, 'sessions'));
  await writeFile(join(home, 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: 'other', status: 'busy' }));
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'session-a', status: 'busy' }));
  assert.equal(await read(), 'busy');
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'session-a', status: 'idle' }));
  assert.equal(await read(), 'idle', 'An interrupt turns it idle even when the transcript says nothing');
  await writeFile(join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: 2 ** 22 + 4099, sessionId: 'session-a', status: 'busy' }));
  assert.equal(await read(), undefined, 'A file left by an exited process says nothing');
});
