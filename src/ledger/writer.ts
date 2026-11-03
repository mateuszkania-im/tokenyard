// NDJSON trace ledger writer (spec 9.1): bounded async queue, hourly files per tenant, one file set per instance.
import { createHash } from 'node:crypto';
import { cliRoot, writeFileUnder } from '../fsutil/safe-path.js';
import { join } from 'node:path';
import type { HeartbeatRecord, SegmentRecord, ShutdownRecord, TraceRecord } from './record.js';

/** 8 hex characters of a hash of hostname and start time, so two instances never write the same file. */
export function defaultInstanceId(hostname: string, startedAtMs: number): string {
  return createHash('sha256').update(`${hostname}\n${startedAtMs}`).digest('hex').slice(0, 8);
}

/** Tenant names come from config but become directory names: keep them from escaping the trace dir. */
export function safeTenantDir(tenant: string): string {
  const s = tenant.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, (dots) => '_'.repeat(dots.length));
  return s === '' ? '_' : s;
}

interface Pending {
  path: string;
  tenant: string;
  /** Writer clock when queued; the segment of a new file starts at the first line's time. */
  at: number;
  /** A request record (counts toward `queueMax` and `dropped`), or a heartbeat or shutdown line. */
  request: boolean;
  line: Record<string, unknown>;
}

export class TraceWriter {
  dropped = 0;
  private seq = 0;
  private queue: Pending[] = [];
  private queuedRequests = 0;
  private opened = new Set<string>();
  private tenants = new Set<string>();
  private draining: Promise<void> | null = null;
  private closed = false;

  /** Trusted root of the trace dir (S-FS-1): no symbolic link from it down to any file written. */
  private readonly root: string;

  constructor(private readonly o: { dir: string; instanceId: string; queueMax: number; clock(): number }) {
    this.root = cliRoot(o.dir);
  }

  private pathFor(tenant: string, nowMs: number): { path: string } {
    const iso = new Date(nowMs).toISOString(); // 2026-11-02T10:30:00.000Z
    return { path: join(this.o.dir, safeTenantDir(tenant), iso.slice(0, 10), `${iso.slice(11, 13)}.${this.o.instanceId}.ndjson`) };
  }

  /** Queues one request record. Never waits on disk; false when the queue was full (the record is dropped, its seq is still used so the gap shows). */
  write(r: Omit<TraceRecord, 'instance' | 'seq'>): boolean {
    const seq = ++this.seq;
    if (this.closed || this.queuedRequests >= this.o.queueMax) {
      this.dropped++;
      return false;
    }
    const at = this.o.clock();
    const { path } = this.pathFor(r.tenant, at);
    this.tenants.add(r.tenant);
    this.queuedRequests++;
    this.queue.push({ path, tenant: r.tenant, at, request: true, line: { ...r, instance: this.o.instanceId, seq } });
    this.kick();
    return true;
  }

  private control(kind: 'heartbeat' | 'shutdown'): void {
    const now = this.o.clock();
    for (const tenant of this.tenants) {
      const { path } = this.pathFor(tenant, now);
      const line: HeartbeatRecord | ShutdownRecord = { v: 1, kind, instance: this.o.instanceId, ts: new Date(now).toISOString(), seq: this.seq };
      this.queue.push({ path, tenant, at: now, request: false, line: { ...line } });
    }
    this.kick();
  }

  /** Called from the sweeper tick (Task 13) and by a 60 s timer in `serve` until then. */
  heartbeat(): void {
    if (!this.closed) this.control('heartbeat');
  }

  private kick(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    await Promise.resolve(); // let a burst of writes in the same tick share one batch
    const batch = this.queue;
    this.queue = [];
    this.queuedRequests = 0;
    const byPath = new Map<string, Pending[]>();
    for (const p of batch) {
      const list = byPath.get(p.path);
      if (list) list.push(p);
      else byPath.set(p.path, [p]);
    }
    for (const [path, items] of byPath) {
      const first = items[0];
      if (!first) continue;
      let text = '';
      if (!this.opened.has(path)) {
        const firstSeq = items.find((i) => i.request)?.line.seq;
        const seg: SegmentRecord = {
          v: 1,
          kind: 'segment',
          instance: this.o.instanceId,
          startedAt: new Date(first.at).toISOString(),
          firstSeq: typeof firstSeq === 'number' ? firstSeq : this.seq + 1,
        };
        text += `${JSON.stringify(seg)}\n`;
        this.opened.add(path);
      }
      text += items.map((i) => `${JSON.stringify(i.line)}\n`).join('');
      try {
        // Directories are created below the root one by one and the file is opened without following links (S-FS-1).
        await writeFileUnder(this.root, path, text, { append: true });
      } catch {
        this.opened.delete(path);
        this.dropped += items.filter((i) => i.request).length;
      }
    }
  }

  /** Resolves when everything queued so far has been written. */
  async flushed(): Promise<void> {
    while (this.draining || this.queue.length > 0) {
      if (!this.draining) this.kick();
      await this.draining;
    }
  }

  /** Writes a shutdown record to every tenant file and drains the queue. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.control('shutdown');
    this.closed = true;
    await this.flushed();
  }
}
