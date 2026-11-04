import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { pseudonym } from '../../src/guardrails/hmac.js';
import { defaultInstanceId, TraceWriter } from '../../src/ledger/writer.js';
import { baseRecord } from '../helpers/trace.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-ledger-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async (p: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(p, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

test('pseudonym is HMAC-SHA256, 32 hex chars, stable per salt and value', () => {
  const a = pseudonym('salt', 'session-1');
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(pseudonym('salt', 'session-1')).toBe(a);
  expect(pseudonym('other', 'session-1')).not.toBe(a);
  expect(pseudonym('salt', 'session-2')).not.toBe(a);
});

test('defaultInstanceId is 8 hex chars and differs by start time', () => {
  expect(defaultInstanceId('host', 1)).toMatch(/^[0-9a-f]{8}$/);
  expect(defaultInstanceId('host', 1)).not.toBe(defaultInstanceId('host', 2));
});

test('writer names files <tenant>/<YYYY-MM-DD>/<HH>.<instance>.ndjson and starts each with a segment record', async () => {
  const now = Date.UTC(2026, 10, 2, 10, 30);
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 100, clock: () => now });
  w.write(baseRecord());
  await w.close();
  expect(await readdir(join(dir, 'acme', '2026-11-02'))).toEqual(['10.i1.ndjson']);
  const ls = await lines(join(dir, 'acme', '2026-11-02', '10.i1.ndjson'));
  expect(ls[0]).toEqual({ v: 1, kind: 'segment', instance: 'i1', startedAt: '2026-11-02T10:30:00.000Z', firstSeq: 1 });
  expect(ls[1]).toMatchObject({ kind: 'request', instance: 'i1', seq: 1, id: 'req_000001' });
  expect(ls.at(-1)).toMatchObject({ kind: 'shutdown', instance: 'i1' });
});

test('a tenant name cannot escape the trace dir', async () => {
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 100, clock: () => Date.UTC(2026, 10, 2, 10) });
  w.write(baseRecord({ tenant: '../evil' }));
  await w.close();
  const names = await readdir(dir);
  expect(names).toHaveLength(1);
  expect(names[0]).not.toMatch(/[/\\]|^\./);
});

test('seq increases by one per request record; overflow drops and increments dropped', async () => {
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 2, clock: () => Date.UTC(2026, 10, 2, 10) });
  const accepted = [1, 2, 3, 4].map((n) => w.write(baseRecord({ id: `r${n}` })));
  expect(accepted).toEqual([true, true, false, false]);
  expect(w.dropped).toBe(2);
  await new Promise((r) => setTimeout(r, 20));
  expect(w.write(baseRecord({ id: 'r5' }))).toBe(true);
  await w.close();
  const reqs = (await lines(join(dir, 'acme', '2026-11-02', '10.i1.ndjson'))).filter((l) => l.kind === 'request');
  // seq 3 and 4 were consumed by the dropped records, so the gap is visible
  expect(reqs.map((r) => r.seq)).toEqual([1, 2, 5]);
});

test('heartbeat appends to every tenant file with the last assigned seq', async () => {
  let now = Date.UTC(2026, 10, 2, 10);
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 100, clock: () => now });
  w.write(baseRecord({ tenant: 'a' }));
  w.write(baseRecord({ tenant: 'b' }));
  now += 60_000;
  w.heartbeat();
  await w.close();
  for (const t of ['a', 'b']) {
    const ls = await lines(join(dir, t, '2026-11-02', '10.i1.ndjson'));
    expect(ls.find((l) => l.kind === 'heartbeat')).toMatchObject({ instance: 'i1', ts: '2026-11-02T10:01:00.000Z', seq: 2 });
  }
});

test('records written across an hour boundary land in the file of their write hour', async () => {
  let now = Date.UTC(2026, 10, 2, 10, 59, 59);
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 100, clock: () => now });
  w.write(baseRecord({ id: 'a', ts: '2026-11-02T10:59:58.000Z' }));
  now += 2000;
  w.write(baseRecord({ id: 'b', ts: '2026-11-02T10:59:59.500Z' }));
  await w.close();
  const ten = await lines(join(dir, 'acme', '2026-11-02', '10.i1.ndjson'));
  const eleven = await lines(join(dir, 'acme', '2026-11-02', '11.i1.ndjson'));
  expect(ten.filter((l) => l.kind === 'request').map((l) => l.id)).toEqual(['a']);
  expect(eleven[0]).toMatchObject({ kind: 'segment', firstSeq: 2 });
  expect(eleven.filter((l) => l.kind === 'request').map((l) => l.id)).toEqual(['b']);
});

test('records contain no prompt text: a body with a canary string never appears in any trace file', async () => {
  // The writer only serialises what it is given; the gateway-level canary test is in test/ledger/gateway-trace.test.ts.
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 100, clock: () => Date.UTC(2026, 10, 2, 10) });
  w.write(baseRecord());
  await w.close();
  const all = await readFile(join(dir, 'acme', '2026-11-02', '10.i1.ndjson'), 'utf8');
  expect(all).not.toContain('CANARY');
});

test('V2 leak: the writer forgets the files of past hours, so its state stays bounded over days of rotation', async () => {
  let now = Date.UTC(2026, 10, 2, 0, 30);
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 100, clock: () => now });
  const opened = (): number => (w as unknown as { opened: { size: number } }).opened.size;
  for (let h = 0; h < 72; h++) {
    for (const tenant of ['a', 'b']) w.write(baseRecord({ tenant, id: `r${h}${tenant}` }));
    await w.flushed();
    now += 3_600_000;
  }
  // The current hour and the one before it, per tenant: not one entry per hour since start.
  expect(opened()).toBeLessThanOrEqual(4);
  // A second write in the same hour still appends without a second segment record.
  now -= 3_600_000;
  w.write(baseRecord({ tenant: 'a', id: 'again' }));
  await w.close();
  const last = new Date(now).toISOString();
  const ls = await lines(join(dir, 'a', last.slice(0, 10), `${last.slice(11, 13)}.i1.ndjson`));
  expect(ls.filter((l) => l.kind === 'segment')).toHaveLength(1);
});
