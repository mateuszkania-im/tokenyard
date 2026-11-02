import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { anonymizeRecord } from '../../src/ledger/anonymize.js';
import { exportTraces, parseDuration, pruneTraces } from '../../src/ledger/export.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { readLedger } from '../../src/ledger/reader.js';
import { TraceWriter } from '../../src/ledger/writer.js';
import { baseRecord } from '../helpers/trace.js';

let dir: string;
let out: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-export-'));
  out = join(dir, 'out.ndjson');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const T = (h: number, m = 0, s = 0): number => Date.UTC(2026, 10, 2, h, m, s);
const iso = (ms: number): string => new Date(ms).toISOString();
const parse = async (p: string): Promise<Array<Record<string, any>>> =>
  (await readFile(p, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

async function writeFileLines(path: string, ls: object[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ls.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('export merges two instances ordered by ts then id and writes the manifest first', async () => {
  const a = new TraceWriter({ dir: join(dir, 't'), instanceId: 'aaaa', queueMax: 10, clock: () => T(10, 5) });
  const b = new TraceWriter({ dir: join(dir, 't'), instanceId: 'bbbb', queueMax: 10, clock: () => T(10, 5) });
  a.write(baseRecord({ id: 'r3', ts: iso(T(10, 2)) }));
  a.write(baseRecord({ id: 'r1', ts: iso(T(10, 1)) }));
  b.write(baseRecord({ id: 'r2', ts: iso(T(10, 1)) }));
  b.write(baseRecord({ id: 'r0', ts: iso(T(10, 0)) }));
  await a.close();
  await b.close();
  const m = await exportTraces({ dir: join(dir, 't'), sinceMs: T(0), untilMs: T(23), out });
  const ls = await parse(out);
  expect(ls[0]?.kind).toBe('manifest');
  expect(ls.slice(1).map((l) => l.id)).toEqual(['r0', 'r1', 'r2', 'r3']);
  expect(m.instances.map((i) => [i.id, i.records, i.seqGaps])).toEqual([
    ['aaaa', 2, 0],
    ['bbbb', 2, 0],
  ]);
  expect(ls[0]).toMatchObject({ since: iso(T(0)), until: iso(T(23)) });
});

test('export writes gzip when the output name ends in .gz and the reader reads it back', async () => {
  const w = new TraceWriter({ dir: join(dir, 't'), instanceId: 'aaaa', queueMax: 10, clock: () => T(10, 5) });
  w.write(baseRecord());
  await w.close();
  const gz = join(dir, 'out.ndjson.gz');
  await exportTraces({ dir: join(dir, 't'), sinceMs: T(0), untilMs: T(23), out: gz });
  expect(gunzipSync(await readFile(gz)).toString('utf8')).toContain('"kind":"manifest"');
  const kinds: string[] = [];
  for await (const l of readLedger([gz])) kinds.push(l.kind);
  expect(kinds).toEqual(['manifest', 'request']);
});

test('manifest reports seqGaps and hoursWithoutFile for an instance missing one hour between heartbeats', async () => {
  const root = join(dir, 't');
  const seg = (h: number, firstSeq: number) => ({ v: 1, kind: 'segment', instance: 'i1', startedAt: iso(T(h)), firstSeq });
  const hb = (h: number, seq: number) => ({ v: 1, kind: 'heartbeat', instance: 'i1', ts: iso(T(h, 30)), seq });
  const req = (h: number, seq: number, id: string) => ({ ...baseRecord({ id, ts: iso(T(h, 10)) }), instance: 'i1', seq });
  await writeFileLines(join(root, 'acme', '2026-11-02', '10.i1.ndjson'), [seg(10, 1), req(10, 1, 'a'), req(10, 3, 'c'), hb(10, 3)]);
  // hour 11 has no file at all
  await writeFileLines(join(root, 'acme', '2026-11-02', '12.i1.ndjson'), [seg(12, 4), req(12, 4, 'd'), hb(12, 5)]);
  const m = await exportTraces({ dir: root, sinceMs: T(0), untilMs: T(23), out });
  const inst = m.instances.find((i) => i.id === 'i1');
  expect(inst).toMatchObject({ records: 3, firstTs: iso(T(10)), lastTs: iso(T(12, 30)) });
  expect(inst?.hoursWithoutFile).toEqual(['2026-11-02T11']);
  // seq 2 is missing between records, seq 5 only shows in the last heartbeat
  expect(inst?.seqGaps).toBe(2);
});

test('export keeps a record that started in one hour but was written in the next', async () => {
  const w = new TraceWriter({ dir: join(dir, 't'), instanceId: 'aaaa', queueMax: 10, clock: () => T(11, 0, 2) });
  w.write(baseRecord({ id: 'late', ts: iso(T(10, 59, 59)) }));
  await w.close();
  await exportTraces({ dir: join(dir, 't'), sinceMs: T(10), untilMs: T(10, 59, 59) + 500, out });
  expect((await parse(out)).slice(1).map((l) => l.id)).toEqual(['late']);
});

test('export --anonymize maps tenant, team, key, repo, branch, ticket to stable pseudonyms and drops client.version', async () => {
  const w = new TraceWriter({ dir: join(dir, 't'), instanceId: 'aaaa', queueMax: 10, clock: () => T(10, 5) });
  w.write(baseRecord({ id: 'r1' }));
  w.write(baseRecord({ id: 'r2', ts: iso(T(10, 1)) }));
  await w.close();
  const opts = { dir: join(dir, 't'), sinceMs: T(0), untilMs: T(23), out, anonymizeSalt: 'salt' };
  await exportTraces(opts);
  const first = await readFile(out, 'utf8');
  const [, r1, r2] = await parse(out);
  expect(r1?.tenant).toMatch(/^tenant-[0-9a-f]{8}$/);
  expect(r1?.team).toMatch(/^team-/);
  expect(r1?.keyId).toMatch(/^key-/);
  expect(r1?.attribution).toMatchObject({ repo: expect.stringMatching(/^repo-/), branch: expect.stringMatching(/^branch-/), ticket: expect.stringMatching(/^ticket-/) });
  expect(r1?.client.version).toBeNull();
  expect(r2?.tenant).toBe(r1?.tenant);
  for (const secret of ['acme', 'web', 'shop', 'ABC-1', 'key_abcd1234', '2.1.0']) expect(first).not.toContain(secret);
  await exportTraces(opts);
  expect(await readFile(out, 'utf8')).toBe(first);
  await exportTraces({ ...opts, anonymizeSalt: 'other' });
  expect((await parse(out))[1]?.tenant).not.toBe(r1?.tenant);
});

test('anonymizeRecord leaves null team, repo, branch and ticket null and calls p with the kind', () => {
  const seen: string[] = [];
  const r = baseRecord({ team: null });
  r.attribution = { ...r.attribution, repo: null, branch: null, ticket: null };
  const a = anonymizeRecord({ ...r, instance: 'i', seq: 1 }, (k, v) => (seen.push(k), `${k}:${v}`));
  expect(seen).toEqual(['tenant', 'key']);
  expect(a.team).toBeNull();
  expect(a.attribution.repo).toBeNull();
});

test('parseDuration and prune', async () => {
  expect(parseDuration('7d')).toBe(7 * 86_400_000);
  expect(parseDuration('12h')).toBe(12 * 3_600_000);
  expect(() => parseDuration('soon')).toThrow();
  const w = new TraceWriter({ dir: join(dir, 't'), instanceId: 'aaaa', queueMax: 10, clock: () => T(10) });
  w.write(baseRecord());
  await w.close();
  const w2 = new TraceWriter({ dir: join(dir, 't'), instanceId: 'aaaa', queueMax: 10, clock: () => T(10) + 10 * 86_400_000 });
  w2.write(baseRecord());
  await w2.close();
  const removed = await pruneTraces({ dir: join(dir, 't'), olderThanMs: 5 * 86_400_000, nowMs: T(10) + 10 * 86_400_000 });
  expect(removed).toBe(1);
  const lines: LedgerLine[] = [];
  await exportTraces({ dir: join(dir, 't'), sinceMs: T(0), untilMs: T(10) + 11 * 86_400_000, out });
  for await (const l of readLedger([out])) lines.push(l);
  expect(lines.filter((l): l is TraceRecord => l.kind === 'request')).toHaveLength(1);
});
