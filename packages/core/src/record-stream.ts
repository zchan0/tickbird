import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { SessionCandidate } from './model';

/** Transport observations only. Raw values must stay behind the provider adapter. */
export interface RecordFrame {
  line: number;
  byteStart: number;
  byteEnd: number;
  kind: 'json' | 'empty' | 'invalid-json' | 'invalid-utf8' | 'oversized';
  value?: unknown;
}

/** Bytes, not strings, are buffered until LF. A temporary EOF never commits a row. */
export class JsonlFramer {
  private storage = Buffer.alloc(0);
  private length = 0;
  private offset = 0;
  private start = 0;
  private line = 0;
  constructor(private readonly maxRecordBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error('Invalid record budget');
  }
  get pendingBytes(): number { return this.length; }
  get bufferedBytes(): number { return this.length > this.maxRecordBytes ? 0 : this.length; }
  get nextLine(): number { return this.line + 1; }
  push(bytes: Buffer): RecordFrame[] {
    const frames: RecordFrame[] = [];
    let from = 0;
    while (from < bytes.length) {
      const lf = bytes.indexOf(10, from);
      const end = lf < 0 ? bytes.length : lf;
      const part = bytes.subarray(from, end);
      const previousLength = this.length;
      this.length += part.length;
      if (this.length <= this.maxRecordBytes) {
        if (this.storage.length < this.length) {
          const grown = Buffer.alloc(Math.min(this.maxRecordBytes, Math.max(this.length, 4096, this.storage.length * 2)));
          this.storage.copy(grown, 0, 0, previousLength); this.storage = grown;
        }
        part.copy(this.storage, previousLength);
      } else this.storage = Buffer.alloc(0);
      this.offset += part.length;
      if (lf < 0) break;
      ++this.offset;
      const frame: RecordFrame = { line: ++this.line, byteStart: this.start, byteEnd: this.offset, kind: 'oversized' };
      if (this.length <= this.maxRecordBytes) {
        const raw = this.storage.subarray(0, this.length);
        try {
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r$/, '');
          if (!text.trim()) frame.kind = 'empty';
          else {
            try { frame.value = JSON.parse(text); frame.kind = 'json'; }
            catch { frame.kind = 'invalid-json'; }
          }
        } catch { frame.kind = 'invalid-utf8'; }
      }
      frames.push(frame);
      if (this.storage.length > 65536) this.storage = Buffer.alloc(0);
      this.length = 0; this.start = this.offset;
      from = lf + 1;
    }
    return frames;
  }
}

export class SourceChangedError extends Error {
  constructor() { super('来源已变化，已停止此代记录；重新核验后才能继续。'); this.name = 'SourceChangedError'; }
}

async function readExactly(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const result = await handle.read(buffer, count, length - count, start + count);
    if (!result.bytesRead) throw new SourceChangedError();
    count += result.bytesRead;
  }
  return buffer;
}

const inProject = (root: string, child: string): boolean => {
  const part = relative(root, child);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !part.startsWith(sep));
};

export interface RecordBatch {
  records: RecordFrame[];
  observedAt: string;
  /** Lower bound on when the polled range could have become available, not a write timestamp. */
  previousCheckAt?: string;
  initialSize: number;
  sizeAtCheck: number;
  offset: number;
  pendingBytes: number;
  caughtUp: boolean;
}

/**
 * Read-only bounded cursor for one verified session. No parser EOF, no body retention,
 * no mtime-derived Agent status, and no automatic rebinding on rotation.
 * Prefix + trailing anchors detect common rewrites; they do NOT authenticate every
 * old byte against a concurrent interior rewrite followed by append. Report this
 * boundary until a stronger history-generation/index policy has been validated.
 */
export class SessionRecordCursor {
  private readonly framer: JsonlFramer;
  private offset = 0;
  private anchor = Buffer.alloc(0);
  private closed = false;
  private failed = false;
  private serial: Promise<unknown> = Promise.resolve();
  private previousCheckAt?: string;
  private lastSize: number;
  private lastMtime: number;
  private lastCtime: number;

  private constructor(private readonly handle: FileHandle, readonly candidate: SessionCandidate,
    private readonly prefix: Buffer, private readonly identity: { dev: number; ino: number },
    readonly initialSize: number, stamp: { mtimeMs: number; ctimeMs: number }, maxRecordBytes?: number) {
    this.framer = new JsonlFramer(maxRecordBytes);
    this.lastSize = initialSize; this.lastMtime = stamp.mtimeMs; this.lastCtime = stamp.ctimeMs;
  }

  static async open(candidate: SessionCandidate, options: { maxRecordBytes?: number } = {}): Promise<SessionRecordCursor> {
    const handle = await open(candidate.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('会话来源不是普通文件。');
      const prefix = await readExactly(handle, 0, Math.min(info.size, 131072));
      // Only complete prefix rows can establish identity. Never inspect arbitrary bodies first.
      const lines = prefix.toString('utf8').split('\n').slice(0, -1).slice(0, 50);
      let meta: { id: string; cwd: string } | undefined;
      for (const line of lines) {
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        if (candidate.provider === 'codex') {
          const p = record?.type === 'session_meta' ? record.payload : undefined;
          if (!p || (p.source && typeof p.source === 'object' && Object.hasOwn(p.source, 'subagent'))) break;
          if (typeof p.id === 'string' && typeof p.cwd === 'string') meta = { id: p.id, cwd: p.cwd };
          break;
        }
        if (record && typeof record.sessionId === 'string' && typeof record.cwd === 'string' && !record.isSidechain) {
          meta = { id: record.sessionId, cwd: record.cwd }; break;
        }
      }
      if (!meta || meta.id !== candidate.id) throw new Error('尚无匹配的完整会话身份记录；未开始观察正文。');
      const project = await realpath(candidate.projectPath);
      const cwd = await realpath(meta.cwd);
      if (candidate.provider === 'codex' ? cwd !== project : !inProject(project, cwd)) throw new Error('会话不属于选定项目。');
      const current = await lstat(candidate.file);
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new SourceChangedError();
      return new SessionRecordCursor(handle, { ...candidate }, prefix, info, info.size, info, options.maxRecordBytes);
    } catch (error) { await handle.close(); throw error; }
  }

  read(byteBudget = 256 * 1024): Promise<RecordBatch> {
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > 4 * 1024 * 1024) return Promise.reject(new Error('Invalid read budget'));
    const action = this.serial.then(() => this.readBatch(byteBudget));
    this.serial = action.catch(() => undefined);
    return action;
  }

  private async readBatch(byteBudget: number): Promise<RecordBatch> {
    if (this.closed || this.failed) throw new Error('观察游标已关闭或需要重新核验。');
    try {
      const checkedAt = new Date().toISOString();
      const before = await this.handle.stat();
      const path = await lstat(this.candidate.file);
      if (!path.isFile() || path.dev !== this.identity.dev || path.ino !== this.identity.ino || before.size < this.lastSize ||
        (before.size === this.lastSize && (before.mtimeMs !== this.lastMtime || before.ctimeMs !== this.lastCtime))) throw new SourceChangedError();
      if (!(await readExactly(this.handle, 0, this.prefix.length)).equals(this.prefix)) throw new SourceChangedError();
      if (this.anchor.length && !(await readExactly(this.handle, this.offset - this.anchor.length, this.anchor.length)).equals(this.anchor)) throw new SourceChangedError();
      const length = Math.min(byteBudget, before.size - this.offset);
      const bytes = await readExactly(this.handle, this.offset, length);
      const after = await this.handle.stat();
      const current = await lstat(this.candidate.file);
      if (!current.isFile() || current.dev !== this.identity.dev || current.ino !== this.identity.ino || after.size < before.size ||
        (after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs))) throw new SourceChangedError();
      // If appending raced the read, ensure the range just consumed stayed unchanged.
      if (after.mtimeMs !== before.mtimeMs && !(await readExactly(this.handle, this.offset, length)).equals(bytes)) throw new SourceChangedError();
      if (this.closed) throw new Error('观察游标已关闭。');
      const observedAt = new Date().toISOString();
      const previousCheckAt = this.previousCheckAt;
      this.offset += bytes.length;
      this.anchor = Buffer.from(Buffer.concat([this.anchor, bytes]).subarray(-4096));
      const records = this.framer.push(bytes);
      this.lastSize = after.size; this.lastMtime = after.mtimeMs; this.lastCtime = after.ctimeMs;
      // Catch-up scans must not imply a tight write-time bound for unread historical bytes.
      if (this.offset === before.size) this.previousCheckAt = checkedAt;
      return { records, observedAt, previousCheckAt, initialSize: this.initialSize, sizeAtCheck: before.size,
        offset: this.offset, pendingBytes: this.framer.pendingBytes, caughtUp: this.offset === before.size };
    } catch (error) { this.failed = true; throw error; }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.serial;
    await this.handle.close();
  }
}
