/** Metadata-only timing of the production source -> parser -> rendered delta path. No Webview is claimed. */
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverSessions } from '../packages/core/src/sessions';
import { openLiveSession } from '../packages/core/src/live-session';
import { LiveView } from '../packages/vscode/src/live-view';

async function main() {
  const [provider, id, secondsText = '30'] = process.argv.slice(2), seconds = Number(secondsText);
  if (!['codex', 'claude'].includes(provider) || !id || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('usage');
  const found = await discoverSessions({ projectPath: process.cwd() });
  const candidate = found.candidates.find(candidate => candidate.id === id && candidate.provider === provider);
  if (!candidate) throw new Error('candidate');
  const started = performance.now();
  const live = await openLiveSession(candidate);
  try {
    const loaded = performance.now(), view = new LiveView('agent-sidecar', live.session), projected = performance.now();
    const entries: unknown[] = [{ kind: 'initial', observedAt: new Date().toISOString(), provider, sessionId: id,
      readBytes: live.health.readBytes, items: live.session.items.length, turns: view.current.turns.length,
      loadMs: Math.round(loaded - started), projectionMs: Math.round(projected - loaded), htmlBytes: Buffer.byteLength(JSON.stringify(view.current)) }];
    live.start(update => {
      const start = performance.now(), message = view.update(update.session, update.health);
      entries.push({ kind: 'delta-projection', observedAt: new Date().toISOString(), readBytes: update.health.readBytes,
        state: update.health.state, pendingBytes: update.health.pendingBytes, contentChanged: update.contentChanged,
        version: message.version, changedTurns: message.turns.length, bytes: Buffer.byteLength(JSON.stringify(message)),
        projectionMs: Math.round(performance.now() - start), items: update.session.items.length });
    });
    console.log(JSON.stringify({ observing: true, seconds, boundary: 'source-to-projection; not DOM or Agent UI' }));
    await delay(seconds * 1000); await live.close();
    entries.push({ kind: 'finish', observedAt: new Date().toISOString(), rssBytes: process.memoryUsage().rss });
    const directory = join(process.cwd(), '.test-artifacts'); await mkdir(directory, { recursive: true });
    const path = join(directory, `live-bridge-${provider}-${Date.now()}.jsonl`);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'); }
    finally { await file.close(); }
    console.log(JSON.stringify({ path, updates: entries.length - 2 }));
  } finally { await live.close(); }
}
void main().catch(() => { console.error('Live bridge probe failed; no raw source content reported.'); process.exitCode = 1; });
