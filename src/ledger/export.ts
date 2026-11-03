// Export (spec 9.5): merge every instance's files in a window into one ordered set with a manifest line first.
import { lstat, rmdir, unlink } from 'node:fs/promises';
import { checkPath, cliRoot, listDirUnder, writeFileUnder } from '../fsutil/safe-path.js';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { anonymizeRecord, saltedPseudonyms } from './anonymize.js';
import { readLedger } from './reader.js';
import type { HeartbeatRecord, ManifestRecord, SegmentRecord, TraceRecord } from './record.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const FILE_NAME = /^(\d{2})\.(.+)\.ndjson(\.gz)?$/;

/** `7d` or `12h`, in milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)([hd])$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}": use a number and h or d, for example 7d`);
  return Number(m[1]) * (m[2] === 'h' ? HOUR_MS : DAY_MS);
}

export interface LedgerFile {
  path: string;
  tenantDir: string;
  instance: string;
  /** Start of the UTC hour in the file name. */
  hourMs: number;
}

/** Every `<tenant>/<YYYY-MM-DD>/<HH>.<instance>.ndjson` file under `dir` whose hour starts in [fromMs, toMs]. */
export async function listLedgerFiles(dir: string, fromMs: number, toMs: number): Promise<LedgerFile[]> {
  const out: LedgerFile[] = [];
  // The trace dir must be no symbolic link below its root (S-FS-1); linked entries inside it are skipped, not followed.
  const root = cliRoot(dir);
  await checkPath(root, dir, { allowMissing: true });
  if ((await lstat(dir).catch(() => null))?.isDirectory() !== true) return out;
  const entries = async (p: string, kind: 'dir' | 'file'): Promise<string[]> =>
    (await listDirUnder(root, p).catch(() => [])).filter((e) => (kind === 'dir' ? e.isDirectory() : e.isFile())).map((e) => e.name);
  for (const tenantDir of await entries(dir, 'dir')) {
    for (const date of await entries(join(dir, tenantDir), 'dir')) {
      if (!DATE_DIR.test(date)) continue;
      const dayMs = Date.parse(`${date}T00:00:00.000Z`);
      if (dayMs + DAY_MS <= fromMs || dayMs > toMs) continue;
      for (const f of await entries(join(dir, tenantDir, date), 'file')) {
        const m = FILE_NAME.exec(f);
        if (!m) continue;
        const hourMs = dayMs + Number(m[1]) * HOUR_MS;
        if (hourMs >= fromMs && hourMs <= toMs) out.push({ path: join(dir, tenantDir, date, f), tenantDir, instance: m[2] as string, hourMs });
      }
    }
  }
  return out.sort((a, b) => a.hourMs - b.hourMs || a.path.localeCompare(b.path));
}

const hourLabel = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

interface InstanceAcc {
  hours: Set<number>;
  firstTs: number;
  lastTs: number;
  seqs: Set<number>;
  /** Request records inside the window (what the export emits). */
  emitted: number;
  minSeq: number;
  maxSeq: number;
  /** Latest ts of any line of this instance, in the window or not, and of its latest shutdown record. */
  lastSignal: number;
  lastShutdown: number;
}

/**
 * Reads every instance's files for requests that started in [sinceMs, untilMs]. A record is written in the hour it
 * is queued, which can be the hour after its start, so files up to one hour past `untilMs` are read.
 */
export async function exportTraces(o: { dir: string; sinceMs: number; untilMs: number; out: string; anonymizeSalt?: string }): Promise<ManifestRecord> {
  const files = await listLedgerFiles(o.dir, Math.floor(o.sinceMs / HOUR_MS) * HOUR_MS, Math.floor(o.untilMs / HOUR_MS) * HOUR_MS + HOUR_MS);
  const instances = new Map<string, InstanceAcc>();
  const acc = (id: string): InstanceAcc => {
    let a = instances.get(id);
    if (!a) instances.set(id, (a = { hours: new Set(), firstTs: Infinity, lastTs: -Infinity, seqs: new Set(), emitted: 0, minSeq: Infinity, maxSeq: -Infinity, lastSignal: -Infinity, lastShutdown: -Infinity }));
    return a;
  };
  const inWindow = (ms: number): boolean => ms >= o.sinceMs && ms <= o.untilMs;
  const seen = (a: InstanceAcc, ms: number): void => {
    a.firstTs = Math.min(a.firstTs, ms);
    a.lastTs = Math.max(a.lastTs, ms);
  };
  const records: Array<{ ms: number; r: TraceRecord }> = [];

  for (const f of files) {
    acc(f.instance).hours.add(f.hourMs);
    for await (const line of readLedger([f.path])) {
      // Seq numbers are assigned when a request finishes, so a request that started before `since` or after `until`
      // still fills a seq slot. Every line counts for seq accounting; the window only decides what is emitted.
      if (line.kind === 'request') {
        const a = acc(line.instance);
        a.seqs.add(line.seq);
        a.minSeq = Math.min(a.minSeq, line.seq);
        a.maxSeq = Math.max(a.maxSeq, line.seq);
        const ms = Date.parse(line.ts);
        a.lastSignal = Math.max(a.lastSignal, ms);
        if (!inWindow(ms)) continue;
        seen(a, ms);
        a.emitted++;
        records.push({ ms, r: line });
      } else if (line.kind === 'heartbeat' || line.kind === 'shutdown') {
        const a = acc(line.instance);
        a.maxSeq = Math.max(a.maxSeq, line.seq);
        const ms = Date.parse((line as HeartbeatRecord).ts);
        if (inWindow(ms)) seen(a, ms);
        a.lastSignal = Math.max(a.lastSignal, ms);
        if (line.kind === 'shutdown') a.lastShutdown = Math.max(a.lastShutdown, ms);
      } else if (line.kind === 'segment') {
        const seg = line as SegmentRecord;
        const a = acc(seg.instance);
        a.minSeq = Math.min(a.minSeq, seg.firstSeq);
        const ms = Date.parse(seg.startedAt);
        if (inWindow(ms)) seen(a, ms);
        a.lastSignal = Math.max(a.lastSignal, ms);
      }
    }
  }

  const manifest: ManifestRecord = {
    v: 1,
    kind: 'manifest',
    since: new Date(o.sinceMs).toISOString(),
    until: new Date(o.untilMs).toISOString(),
    instances: [...instances]
      .filter(([, a]) => a.firstTs !== Infinity)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([id, a]) => {
        const hours = [...a.hours];
        const first = Math.min(...hours);
        const last = Math.max(...hours);
        const hoursWithoutFile: string[] = [];
        for (let h = first; h <= last; h += HOUR_MS) if (!a.hours.has(h)) hoursWithoutFile.push(hourLabel(h));
        let seqGaps = 0;
        for (let s = a.minSeq; s <= a.maxSeq; s++) if (!a.seqs.has(s)) seqGaps++;
        return {
          id,
          firstTs: new Date(a.firstTs === Infinity ? first : a.firstTs).toISOString(),
          lastTs: new Date(a.lastTs === -Infinity ? last : a.lastTs).toISOString(),
          records: a.emitted,
          seqGaps,
          hoursWithoutFile,
          shutdown: a.lastShutdown !== -Infinity && a.lastShutdown >= a.lastSignal,
        };
      }),
  };

  records.sort((a, b) => a.ms - b.ms || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
  const p = o.anonymizeSalt === undefined ? null : saltedPseudonyms(o.anonymizeSalt);
  // Anonymized: record ids become their position in the export (zero-padded, so ts-then-id order is unchanged) and
  // instance ids are re-keyed in the manifest exactly as in the records.
  const width = String(records.length).length;
  const lines: object[] = p
    ? [
        { ...manifest, instances: manifest.instances.map((i) => ({ ...i, id: p('instance', i.id) })) },
        ...records.map(({ r }, i) => ({ ...anonymizeRecord(r, p), id: `req-${String(i + 1).padStart(width, '0')}` })),
      ]
    : [manifest, ...records.map(({ r }) => r)];
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  await writeFileUnder(cliRoot(o.out), o.out, o.out.endsWith('.gz') ? gzipSync(text) : text);
  return manifest;
}

/** Deletes files whose whole hour ended more than `olderThanMs` before `nowMs`, then empty day and tenant folders. Returns the files removed. */
export async function pruneTraces(o: { dir: string; olderThanMs: number; nowMs: number }): Promise<number> {
  const cutoff = o.nowMs - o.olderThanMs;
  const old = (await listLedgerFiles(o.dir, 0, cutoff - HOUR_MS)).filter((f) => f.hourMs + HOUR_MS <= cutoff);
  for (const f of old) await unlink(f.path);
  for (const f of old) {
    const day = join(f.path, '..');
    await rmdir(day).then(() => rmdir(join(day, '..'))).catch(() => undefined); // only succeeds when empty
  }
  return old.length;
}

/** Request records from a trace dir (raw per-instance files) or from one export file, filtered to the window and optionally one tenant. */
export async function loadTraceRecords(o: { path: string; sinceMs: number; untilMs: number; tenant?: string }): Promise<TraceRecord[]> {
  await checkPath(cliRoot(o.path), o.path);
  const isDir = (await lstat(o.path)).isDirectory();
  const paths = isDir
    ? (await listLedgerFiles(o.path, Math.floor(o.sinceMs / HOUR_MS) * HOUR_MS, Math.floor(o.untilMs / HOUR_MS) * HOUR_MS + HOUR_MS)).map((f) => f.path)
    : [o.path];
  const out: TraceRecord[] = [];
  for await (const line of readLedger(paths)) {
    if (line.kind !== 'request') continue;
    const ms = Date.parse(line.ts);
    if (ms >= o.sinceMs && ms <= o.untilMs && (o.tenant === undefined || line.tenant === o.tenant)) out.push(line);
  }
  return out;
}
