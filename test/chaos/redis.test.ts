// V3 chaos, scenario 3: the Redis counter store goes away and comes back under load. Runs through `npm run test:chaos`
// (scripts/local-redis.mjs starts a loopback-only container and passes REDIS_URL and REDIS_CONTAINER); skipped
// otherwise. Two outages: `docker pause` (the connection stays up, commands hang until unpause) and killed client
// connections whose reconnects are refused for 800 ms (commands fail at once while node-redis retries). While the store is down, budgets are closed (503,
// nothing sent); afterwards requests succeed, nothing is charged twice, the sweeper leaves no reservation behind, and
// the R11 latch and the session markers written before the outage are still there.
import { execFileSync } from 'node:child_process';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import { r11LatchKey } from '../../src/limits/keys.js';
import { openCounterStore } from '../../src/limits/open-store.js';
import { createRedisStore } from '../../src/limits/redis-store.js';
import { isLoopbackRedisUrl } from '../../scripts/local-redis.mjs';
import { chaosRequest, chatBody, checkInvariants, type ClientResult, type Harness, startHarness } from './harness.js';

const url = process.env.REDIS_URL;
const container = process.env.REDIS_CONTAINER;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]): void => void execFileSync('docker', args, { stdio: 'ignore' });

describe.skipIf(!url || !container || !isLoopbackRedisUrl(url ?? ''))('redis down and back (REDIS_URL, REDIS_CONTAINER)', () => {
  const admin = createClient({ url });
  let h: Harness | null = null;
  let closeStore: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    await admin.connect();
  });
  afterEach(async () => {
    try {
      docker('unpause', container as string);
    } catch {
      // not paused
    }
    await h?.close();
    await closeStore?.();
    h = null;
    closeStore = null;
  });
  afterAll(async () => {
    await admin.flushDb();
    await admin.close();
  });

  /** Keys of open reservations, deadline entries, stream slots in use and budget keys with something reserved. */
  async function leftovers(): Promise<string[]> {
    const out: string[] = [];
    for (const k of await admin.keys('ty:*')) {
      if (k.includes(':res:')) out.push(k);
      else if (k.endsWith(':deadlines') && (await admin.zCard(k)) > 0) out.push(k);
      else if (k.includes(':st:') && Number(await admin.get(k)) > 0) out.push(k);
      else if (k.includes(':b:') && Number((await admin.hGet(k, 'r')) ?? 0) !== 0) out.push(k);
    }
    return out;
  }

  /** Spent on the team-day budget key (every request of the test key lands on it). */
  async function teamDaySpent(): Promise<number> {
    const key = (await admin.keys('ty:*:b:team-day:*'))[0];
    return key ? Number((await admin.hGet(key, 's')) ?? 0) : 0;
  }

  /** Requests every `everyMs` until `ms` elapsed, in parallel; resolves with all results. */
  async function stream(prefix: string, ms: number, everyMs: number): Promise<ClientResult[]> {
    const runs: Array<Promise<ClientResult>> = [];
    const until = Date.now() + ms;
    for (let i = 0; Date.now() < until; i++) {
      const id = `${prefix}${i}`;
      runs.push(chaosRequest((h as Harness).url, id, chatBody(id)));
      await sleep(everyMs);
    }
    return Promise.all(runs);
  }

  test('docker pause mid-load: budgets closed (503) while it hangs, recovery after unpause, no double charge, nothing left after the sweep', async () => {
    await admin.flushDb();
    const runtime = createGatewayRuntime();
    // Every reservation a sweep settled, whatever the trace line says: the store charged exactly its estimate.
    const swept = new Set<string>();
    const onSwept = (ids: string[]): void => {
      for (const id of ids) swept.add(id);
      runtime.onSwept(ids);
    };
    const opened = await openCounterStore({ kind: 'redis', redisUrl: url as string, instance: 'chaos', onSwept });
    closeStore = opened.close;
    h = await startHarness({ store: opened.store, runtime, admitTimeoutMs: 300 });
    h.setBehaviour(() => ({ kind: 'ok', stream: true, padEvents: 20, chunkDelayMs: 5 }));
    // Before the outage: the R11 latch and session markers exist.
    await opened.store.latchBoundOff?.();
    const warm = await stream('warm', 300, 20);
    expect(warm.every((r) => r.status === 200)).toBe(true);
    const markers = (await admin.keys('ty:*:sess:*')).sort();
    expect(markers.length).toBeGreaterThan(0);

    const load = stream('pz', 3_000, 15);
    await sleep(800);
    docker('pause', container as string);
    await sleep(1_200);
    docker('unpause', container as string);
    const during = await load;
    const statuses = new Set(during.map((r) => r.status));
    expect([...statuses].sort()).toEqual([200, 503]);
    // Recovered: the last requests went through.
    expect(during.slice(-10).every((r) => r.status === 200)).toBe(true);
    const sent = [...warm, ...during];
    await checkInvariants(h, sent, { expectSweeper: true, skipStore: true });

    // Settles that timed out while paused ran when Redis came back (they were queued on the live connection), or are
    // the sweeper's: after a sweep nothing is open.
    await opened.store.sweep(Date.now());
    expect(await leftovers()).toEqual([]);
    // No double charge, exactly: each reservation was settled once, either by its request (the store got the actual
    // cost) or by a sweep (the store got the estimate). A sweeper-labelled line whose sweep never came was a settle that
    // timed out while paused and landed after the unpause with the actual cost (R-V3-2: its line says the estimate).
    // A settle and a sweep of the same reservation, or two settles, would add a second charge and break the equality.
    const charged = h.records.map((r) => r.outcome.chargedMicroUsd ?? 0);
    const expected = h.records.reduce((t, r) => {
      if (r.decision.reservedMicroUsd === 0) return t;
      const late = r.outcome.settledBy === 'sweeper' && !swept.has(r.id);
      return t + (late ? (r.outcome.costMicroUsd ?? 0) : (r.outcome.chargedMicroUsd ?? 0));
    }, 0);
    const lateSettles = h.records.filter((r) => r.outcome.settledBy === 'sweeper' && !swept.has(r.id)).length;
    const spent = await teamDaySpent();
    expect(spent).toBe(expected);
    // State from before the outage survived it.
    expect(await admin.exists(r11LatchKey())).toBe(1);
    for (const m of markers) expect(await admin.exists(m), m).toBe(1);
    const count = (st: number): number => during.filter((r) => r.status === st).length;
    console.log(`redis pause: ${during.length} requests, ${count(200)} x 200, ${count(503)} x 503; settledBy sweeper ${h.records.filter((r) => r.outcome.settledBy === 'sweeper').length} (${swept.size} swept, ${lateSettles} late settles); spent ${spent} = expected ${expected}, trace charges ${charged.reduce((a, b) => a + b, 0)}`);
  }, 60_000);

  test('connection killed and refused for 800 ms under load: commands fail at once, budgets closed, reconnect, unsettled reservations swept at their estimate, spent equals the trace charges', async () => {
    await admin.flushDb();
    const runtime = createGatewayRuntime();
    // The client as openCounterStore builds it (no offline queue, reconnect with backoff), with a short reservation
    // deadline so the sweeper's part is seen within the test; the request deadline stays below it.
    const client = createClient({ url, disableOfflineQueue: true, socket: { reconnectStrategy: (n: number) => Math.min(100 * 2 ** n, 2_000) } });
    client.on('error', () => undefined);
    await client.connect();
    closeStore = async () => void (await client.close());
    const store = createRedisStore(client, { deadlineMs: 1_500, onSwept: (ids) => runtime.onSwept(ids) });
    h = await startHarness({ store, runtime, admitTimeoutMs: 300, requestDeadlineMs: 1_200 });
    h.setBehaviour(() => ({ kind: 'ok', stream: true, padEvents: 20, chunkDelayMs: 10 }));
    const load = stream('kill', 4_000, 15);
    // Down for 800 ms: connections killed and reconnects refused (another password) until it is restored.
    const password = decodeURIComponent(new URL(url as string).password);
    await sleep(700);
    await admin.sendCommand(['CONFIG', 'SET', 'requirepass', `${password}-down`]);
    await admin.sendCommand(['CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes']);
    await sleep(800);
    await admin.sendCommand(['CONFIG', 'SET', 'requirepass', password]);
    const sent = await load;
    expect(sent.some((r) => r.status === 503)).toBe(true);
    expect(sent.slice(-10).every((r) => r.status === 200)).toBe(true);
    await checkInvariants(h, sent, { expectSweeper: true, skipStore: true });
    await expect.poll(() => (h as Harness).records.length).toBe((h as Harness).ids.length);
    // Past the reservation deadline the sweeper settles what the killed connection left open.
    await sleep(1_700);
    await store.sweep(Date.now());
    expect(await leftovers()).toEqual([]);
    const total = h.records.reduce((a, r) => a + (r.outcome.chargedMicroUsd ?? 0), 0);
    expect(await teamDaySpent()).toBe(total);
    console.log(`redis client kill: ${sent.length} requests, ${sent.filter((r) => r.status === 200).length} x 200, ${sent.filter((r) => r.status === 503).length} x 503; settledBy sweeper ${h.records.filter((r) => r.outcome.settledBy === 'sweeper').length}; spent ${total}`);
  }, 60_000);
});
