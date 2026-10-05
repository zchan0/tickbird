import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { discoverSessions, loadSession, sessionKey } from '../packages/core/src/sessions';
import { groupSessionTurns } from '../packages/core/src/timeline';
import { outlineCoverage, visibleTurnGroups } from '../packages/core/src/outline';

async function main() {
  // A worktree has no sessions of its own: SIDECAR_PROJECT_PATH names the project to check.
  const projectPath = process.env.SIDECAR_PROJECT_PATH ?? resolve(__dirname, '../..');
  const discovery = await discoverSessions({ projectPath });
  const keys = discovery.candidates.map(sessionKey);
  assert.equal(new Set(keys).size, keys.length, 'Session candidates must be unique by provider and session ID');
  const results = [];
  for (const candidate of discovery.candidates) {
    try {
      const session = await loadSession(candidate);
      const groups = groupSessionTurns(session);
      const groupedItems = groups.flatMap(group => group.items);
      assert.equal(session.id, candidate.id);
      assert.equal(session.provider, candidate.provider);
      assert.equal(groupedItems.length, session.items.length);
      assert.equal(new Set(groupedItems.map(item => item.id)).size, session.items.length);
      assert.ok(groups.every(group => group.items.every(item => item.sessionId === session.id && item.turnId === group.turnId)));
      const visible = visibleTurnGroups(session);
      const visibleKeys = new Set(visible.map(group => group.key));
      const hidden = groups.filter(group => !visibleKeys.has(group.key));
      for (const group of visible) {
        const original = groups.find(source => source.key === group.key)!;
        assert.equal(group.ordinal, original.ordinal, 'Display filtering must not renumber turns');
        assert.deepEqual(group.items, original.items);
      }
      assert.ok(hidden.every(group => group.items.every(item => !['request', 'answer', 'question', 'message', 'tool', 'file-change'].includes(item.kind))));
      const routes = outlineCoverage(session);
      assert.equal(routes.length, session.items.length);
      assert.equal(new Set(routes.map(route => route.itemId)).size, session.items.length);
      assert.ok(hidden.every(group => group.items.every(item => routes.some(route => route.itemId === item.id && route.surface === 'empty-turn-metadata'))));
      results.push({ provider: session.provider, sessionId: session.id, file: candidate.file, passed: true,
        turns: groups.filter(group => group.turnId).length, items: session.items.length,
        visibleTurns: visible.filter(group => group.turnId).length,
        hiddenEmptyTurns: hidden.filter(group => group.turnId).map(group => ({ turnId: group.turnId, ordinal: group.ordinal, itemCount: group.items.length })),
        unassigned: groups.filter(group => !group.turnId).reduce((count, group) => count + group.items.length, 0) });
    } catch (error) {
      results.push({ provider: candidate.provider, sessionId: candidate.id, passed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const passed = results.length > 0 && results.every(result => result.passed);
  const report = { kind: 'real-project-session-turn-identity-not-ui-acceptance', generatedAt: new Date().toISOString(), passed,
    projectPath, warnings: discovery.warnings, results,
    limitations: ['Current local snapshots, not a complete original-UI session catalog.',
      'A turn count uses recorded identities; not a count of user-visible messages.',
      'No conversation bodies, images, hidden instructions or credentials are written to this report.',
      'Known subagent logs are omitted from main-session candidates; parent public returns remain in scope.'] };
  await mkdir(join(projectPath, '.test-artifacts'), { recursive: true });
  await writeFile(join(projectPath, '.test-artifacts/session-granularity.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
