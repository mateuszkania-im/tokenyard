// A11 (security review A): the live harness's cross-run cap ($20 hard cap, R12).
//  (a) Lock race: two starts that both read the same stale lock both unlink and both take the lock (the second unlinks
//      the first one's fresh lock), so two harnesses run on one trace dir and each enforces the full remaining cap.
//      Emulated deterministically by having the second start read the stale pid the first one already replaced.
//  (b) Crash under-count: a request's spend reaches the trace dir only after it settles, so a harness that dies with a
//      request in flight (billed upstream) leaves no record of it; the next run seeds less than was spent.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { authHeaders } from '../helpers/conformance.js';
import { closeAll, closers, raw, readJson, sendAndAbort, sse } from './common.js';

const STALE = { path: '', once: false };
/** Files opened for writing whose name is a lock file: each would be visible empty before its pid is written. */
const OPENED_LOCKS: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const openSync = ((p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && /live\.lock(\.takeover)?$/.test(p)) OPENED_LOCKS.push(p);
    return (fs.openSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.openSync;
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (STALE.once && typeof p === 'string' && p === STALE.path) {
      STALE.once = false;
      return '999999\n'; // the dead pid this start read before the other start replaced the lock
    }
    return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync, openSync }, readFileSync, openSync };
});

const { LIVE_LOCK_FILE, startLiveHarness } = await import('../../src/live/harness.js');

afterEach(async () => {
  await closeAll();
  vi.restoreAllMocks();
});

const REPO = join(import.meta.dirname, '..', '..');
const env = { ANTHROPIC_API_KEY: 'test-provider-key-not-real', TOKENYARD_LIVE_BUDGET_USD: '5' };
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ty-sec-a-'));
  closers.push(async () => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('A11a two starts racing on a stale lock: only one harness may run on a trace dir', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const up = await raw((req, res) => void res.end());
  const traceDir = tmp();
  const first = await startLiveHarness({ env, today: '2026-11-03', traceDir, port: 0, upstream: up.url, policyDir: join(REPO, 'test', 'live') });
  closers.push(first.close);
  STALE.path = join(traceDir, LIVE_LOCK_FILE);
  STALE.once = true;
  let second: Awaited<ReturnType<typeof startLiveHarness>> | null = null;
  try {
    second = await startLiveHarness({ env, today: '2026-11-03', traceDir, port: 0, upstream: up.url, policyDir: join(REPO, 'test', 'live') });
    closers.push(second.close);
  } catch {
    // refused: the property holds
  }
  console.log(`A11a firstRunning=true secondStarted=${second !== null} (each would enforce the full remaining cap of $${env.TOKENYARD_LIVE_BUDGET_USD})`);
  expect(second).toBeNull();
});

test('A11b a request in flight when the harness dies is counted by the next run', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  let got = 0;
  const up = await raw(async (req, res) => {
    await readJson(req);
    got++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 50_000, output_tokens: 1 } } }));
    res.write(': billed-and-streaming\n\n');
  });
  const traceDir = tmp();
  const first = await startLiveHarness({ env, today: '2026-11-03', traceDir, port: 0, upstream: up.url, policyDir: join(REPO, 'test', 'live') });
  const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8000, stream: true, messages: [{ role: 'user', content: 'x' }] }));
  // The client keeps the stream open; the harness "crashes" with it in flight (lock left behind by a dead pid).
  void sendAndAbort(first.url, '/v1/messages', { ...authHeaders, 'x-api-key': first.clientKey }, body, { afterMs: 3000 });
  await expect.poll(() => got).toBe(1);
  // The write-ahead line reaches the trace dir while the request is still in flight.
  await expect.poll(() => readdirSync(traceDir, { recursive: true }).some((f) => String(f).endsWith('.ndjson') && readFileSync(join(traceDir, String(f)), 'utf8').includes('"kind":"reserved"')), { timeout: 5000 }).toBe(true);
  // The harness "crashes": its lock is left behind with a pid that is no longer alive.
  writeFileSync(join(traceDir, LIVE_LOCK_FILE), '999999\n');
  const next = await startLiveHarness({ env, today: '2026-11-03', traceDir, port: 0, upstream: up.url, policyDir: join(REPO, 'test', 'live') });
  closers.push(next.close);
  closers.push(first.close);
  console.log(`A11b inFlightBilledInputTokens=50000 seededSpentMicroUsd=${next.spentMicroUsd}`);
  expect(next.spentMicroUsd).toBeGreaterThan(0);
});

test('A11c warm-up counts a reserved line until its request line appears, and only once after', async () => {
  const { warmupEntries } = await import('../../src/limits/warmup.js');
  const { loadLivePolicy } = await import('../../src/live/harness.js');
  const policy = loadLivePolicy({ capUsd: 5, keyHash: 'a'.repeat(64), dir: join(REPO, 'test', 'live') });
  const now = Date.UTC(2026, 10, 3, 12);
  const ts = new Date(now - 60_000).toISOString();
  const reserved = { v: 1, kind: 'reserved', instance: 'i1', id: 'r1', ts, tenant: 'live', team: 'live', keyId: 'key_aaaaaaaa', billing: 'api', attribution: { repo: null, session: null }, reservedMicroUsd: 700_000 } as const;
  const lines = async function* (xs: unknown[]) {
    yield* xs as never[];
  };
  const pending = await warmupEntries(lines([reserved]), policy, now);
  expect(pending.reduce((n, e) => n + e.spentMicroUsd, 0)).toBe(700_000);
  const settled = { v: 1, kind: 'request', id: 'r1', ts, tenant: 'live', team: 'live', keyId: 'key_aaaaaaaa', billing: 'api', attribution: { repo: null, session: null }, outcome: { costMicroUsd: 1234, chargedMicroUsd: 1234 } };
  const done = await warmupEntries(lines([reserved, settled]), policy, now);
  expect(done.reduce((n, e) => n + e.spentMicroUsd, 0)).toBe(1234);
});

test('A11d fix round: the lock and the takeover file appear with their pid already in them (written, then linked)', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const up = await raw((req, res) => void res.end());
  const traceDir = tmp();
  writeFileSync(join(traceDir, LIVE_LOCK_FILE), '999999\n'); // stale: the start goes through the takeover path too
  OPENED_LOCKS.length = 0;
  const h = await startLiveHarness({ env, today: '2026-11-03', traceDir, port: 0, upstream: up.url, policyDir: join(REPO, 'test', 'live') });
  closers.push(h.close);
  expect(OPENED_LOCKS).toEqual([]);
  expect(readFileSync(join(traceDir, LIVE_LOCK_FILE), 'utf8')).toBe(`${process.pid}\n`);
  expect(readdirSync(traceDir).filter((f) => f.includes('.lock'))).toEqual([LIVE_LOCK_FILE]);
});

test('A11e fix round: the upstream is called only after the reserved line is written; a failed write refuses the request', async () => {
  const { startGateway } = await import('../helpers/gateway.js');
  const { testPolicy, PROVIDER_KEY_ENV } = await import('../helpers/policy.js');
  const { send } = await import('../helpers/conformance.js');
  process.env[PROVIDER_KEY_ENV] = 'k';
  const events: string[] = [];
  const up = await raw(async (req, res) => {
    await readJson(req);
    events.push('upstream');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 5, output_tokens: 5 } }));
  });
  const { createMemoryStore } = await import('../../src/limits/memory-store.js');
  let ok = true;
  const sink = {
    write: () => true,
    reserved: () => new Promise<boolean>((r) => setTimeout(() => (events.push('reserved'), r(ok)), 150)),
  };
  const g = await startGateway({ policy: testPolicy({ upstream: up.url }), store: createMemoryStore({ clock: Date.now }), traces: sink, traceSalt: 's' });
  closers.push(g.close);
  const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body })).status).toBe(200);
  expect(events).toEqual(['reserved', 'upstream']);
  ok = false;
  const refused = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(refused.status).toBe(503);
  expect(events).toEqual(['reserved', 'upstream', 'reserved']);
});

test('A11f fix round: TraceWriter.reserved resolves once the line is on disk', async () => {
  const { TraceWriter } = await import('../../src/ledger/writer.js');
  const dir = tmp();
  const w = new TraceWriter({ dir, instanceId: 'i1', queueMax: 10, clock: Date.now, writeAhead: true });
  const written = await w.reserved({ id: 'r1', ts: new Date().toISOString(), tenant: 'live', team: 'live', keyId: 'k', billing: 'api', attribution: { repo: null, session: null }, reservedMicroUsd: 5 });
  expect(written).toBe(true);
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ndjson'));
  expect(files.some((f) => readFileSync(join(dir, f), 'utf8').includes('"kind":"reserved"'))).toBe(true);
  await w.close();
});
