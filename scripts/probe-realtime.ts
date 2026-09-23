import { mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverSessions } from '../packages/core/src/sessions';
import { SessionRecordCursor } from '../packages/core/src/record-stream';
import { observeRecord } from '../packages/core/src/record-observation';

async function main() {
  const [provider, sessionId, durationArg = '120'] = process.argv.slice(2);
  const duration = Number(durationArg);
  if (!['codex', 'claude'].includes(provider) || !sessionId || !Number.isFinite(duration) || duration < 1 || duration > 600) {
    throw new Error('Usage: probe-realtime <codex|claude> <exact session id> [seconds: 1..600]');
  }
  const projectPath = process.cwd();
  const found = await discoverSessions({ projectPath });
  const matches = found.candidates.filter(c => c.provider === provider && c.id === sessionId);
  if (matches.length !== 1) throw new Error('Exact project-scoped candidate is missing or ambiguous; no fallback selection.');
  const candidate = matches[0];
  const cursor = await SessionRecordCursor.open(candidate);
  const startedAt = new Date().toISOString();
  const directory = resolve(projectPath, '.test-artifacts');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `realtime-${provider}-${Date.now()}.jsonl`);
  const report = await open(file, 'wx', 0o600);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const write = async (value: unknown) => { await report.writeFile(JSON.stringify(value) + '\n'); };
  const historical: Record<string, number> = {};
  const appended: Record<string, number> = {};
  const integrity: Record<string, number> = {};
  let deadline: number | undefined;
  let initialCaughtUpAt: string | undefined;
  let records = 0;
  let bytes = 0;
  let pendingBytes = 0;
  let maxRss = process.memoryUsage().rss;
  const startup = performance.now();
  const overallDeadline = Date.now() + duration * 1000 + 60000;
  let initialScanMs: number | undefined;
  let failure: string | undefined;
  try {
    await write({ kind: 'probe-start', provider, sessionId, projectPath, sourceFile: candidate.file, startedAt,
      initialBytes: cursor.initialSize, pollIntervalMs: 250, requestedSecondsAfterCatchUp: duration,
      limitations: ['Metadata only: no prompts, outputs, private reasoning text, images or credentials.',
        'Historical record timestamps do not prove arrival latency.', 'Presence categories are not content-support or Agent-liveness claims.',
        'Append is relative to the verified open-time byte boundary, not proof of an active UI or token streaming.',
        'Prefix/trailing guards do not authenticate arbitrary old interior rewrites followed by append.',
        '16 MiB per-record parsing budget; oversized rows are counted explicitly, not reported as parsed.',
        'This probe does not measure source-to-Webview latency.'] });
    console.log(JSON.stringify({ kind: 'probe-start', provider, report: file, initialBytes: cursor.initialSize }));
    while (!stopped && Date.now() < overallDeadline && (deadline === undefined || Date.now() < deadline)) {
      const batch = await cursor.read();
      bytes = batch.offset; pendingBytes = batch.pendingBytes;
      for (const frame of batch.records) {
        records++;
        integrity[frame.kind] = (integrity[frame.kind] ?? 0) + 1;
        const isAppend = frame.byteEnd > cursor.initialSize;
        const counter = isAppend ? appended : historical;
        for (const observation of observeRecord(candidate.provider, frame)) {
          counter[observation.category] = (counter[observation.category] ?? 0) + 1;
          if (isAppend) await write({ kind: 'append-observed', line: frame.line, byteStart: frame.byteStart, byteEnd: frame.byteEnd,
            observedAt: batch.observedAt, availabilityLowerBound: batch.previousCheckAt ?? null,
            availabilityUpperBound: batch.observedAt, ...observation });
        }
      }
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
      if (batch.caughtUp) {
        if (deadline === undefined) {
          initialCaughtUpAt = batch.observedAt; initialScanMs = performance.now() - startup;
          deadline = Date.now() + duration * 1000;
          await write({ kind: 'initial-catch-up', initialCaughtUpAt, initialScanMs, bytes, records, historical, appended, integrity });
          console.log(JSON.stringify({ kind: 'initial-catch-up', provider, bytes, records, initialScanMs: Math.round(initialScanMs) }));
        }
        await delay(250);
      } else await delay(0);
    }
    if (!initialCaughtUpAt && !stopped) { failure = 'initial-catch-up-time-budget-exhausted'; process.exitCode = 1; }
  } catch (error) {
    // Do not dump arbitrary OS error strings or source payloads into reports.
    failure = error instanceof Error && error.name === 'SourceChangedError' ? 'source-generation-changed' : 'observation-failed';
    process.exitCode = 1;
  } finally {
    const summary = { kind: 'probe-end', provider, startedAt, finishedAt: new Date().toISOString(), initialCaughtUpAt,
      initialScanMs, initialBytes: cursor.initialSize, bytes, records, pendingBytes, historical, appended, integrity,
      maxRssBytes: maxRss, stoppedBySignal: stopped, failure: failure ?? null, report: file };
    await write(summary);
    console.log(JSON.stringify(summary));
    await cursor.close(); await report.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
void main().catch(() => { console.error('Probe could not start or close; no raw error payload was emitted.'); process.exitCode = 1; });
