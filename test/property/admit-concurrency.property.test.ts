// V4 properties: many admits in flight at once on one key. Each request may carry a new or known session (the S-V2-1
// churn limit), the key's GCRA, its stream slot and a budget level; all are issued without awaiting, so they race
// in one batch. On the memory store (one thread) and on Redis (one connection, scripts run in arrival order) the
// commit order is the issue order, so every admission must equal a sequential model applied in that order; settling
// the batch (in random order, some concurrently with a second batch) frees every slot and every reservation. The R11
// latch read concurrently with many latch writes is monotone: once seen set, it stays set.
import fc from 'fast-check';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { budgetKey, gcraKey, newSessionsKey, sessionKey, streamKey } from '../../src/limits/keys.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { createRedisStore } from '../../src/limits/redis-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { Plan } from '../../src/policy/types.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Shape {
  burst: number;
  slots: number;
  sessionBurst: number;
  limit: number;
  requests: Array<{ session: number | null; rate: boolean; slot: boolean; est: number }>;
}
const shape: fc.Arbitrary<Shape> = fc.record({
  burst: fc.integer({ min: 1, max: 20 }),
  slots: fc.integer({ min: 1, max: 8 }),
  sessionBurst: fc.integer({ min: 1, max: 6 }),
  limit: fc.integer({ min: 0, max: 3_000 }),
  requests: fc.array(fc.record({ session: fc.option(fc.nat(9), { freq: 4, nil: null }), rate: fc.boolean(), slot: fc.boolean(), est: fc.noBias(fc.integer({ min: 0, max: 300 })) }), { minLength: 1, maxLength: 80, size: 'max' }),
});

let n = 0;
function plans(s: Shape): { plans: Plan[]; tenant: string } {
  const tenant = `c${++n}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    tenant,
    plans: s.requests.map((r, i) => ({
      id: `q${i}`, policyRevision: 'r', route: 'r', chain: [], taint: null, preBlock: null, warnings: [],
      reservations: [{ budget: 'org', key: budgetKey(tenant, 'org', tenant, '2026-11-03'), limitMicroUsd: s.limit, estMicroUsd: r.est, enforce: true, resetsAt: new Date(Date.now() + DAY).toISOString() }],
      rateChecks: r.rate ? [{ limit: 'rpm', key: gcraKey(tenant, 'rpm', 'k'), emissionMs: HOUR, burst: s.burst, quantity: 1 }] : [],
      streamSlots: r.slot ? [{ limit: 'streams', key: streamKey(tenant, 'streams', 'k'), max: s.slots }] : [],
      newSession: r.session === null ? null : { limit: 'new-sessions', markerKey: sessionKey(tenant, `s${r.session}`), key: newSessionsKey(tenant, 'k'), emissionMs: HOUR / s.sessionBurst, burst: s.sessionBurst, ttlMs: DAY },
    })),
  };
}

/** The sequential model, in issue order: what each admit must return (refusal kind or 'ok'). */
function model(s: Shape): string[] {
  const known = new Set<number>();
  let sessions = 0;
  let rate = 0;
  let slots = 0;
  let reserved = 0;
  return s.requests.map((r) => {
    const isNew = r.session !== null && !known.has(r.session);
    if (isNew && sessions >= s.sessionBurst) return 'sessions';
    if (r.rate && rate >= s.burst) return 'rate';
    if (r.slot && slots >= s.slots) return 'streams';
    if (reserved + r.est > s.limit) return 'budget';
    if (isNew) {
      sessions++;
      known.add(r.session as number);
    }
    if (r.rate) rate++;
    if (r.slot) slots++;
    reserved += r.est;
    return 'ok';
  });
}

async function batch(store: CounterStore, s: Shape, settleOrder: readonly number[]): Promise<void> {
  const { plans: ps, tenant } = plans(s);
  const got = (await Promise.all(ps.map((p) => store.admit(p)))).map((a) => (a.admitted ? 'ok' : (a.failed?.kind ?? '?')));
  expect(got).toEqual(model(s));
  // Settle the admitted ones in a random order, all at once, while a second batch of slot-only admits races them.
  const admitted = ps.filter((_, i) => got[i] === 'ok');
  const order = admitted.map((p, i) => ({ p, k: settleOrder[i % Math.max(1, settleOrder.length)] ?? i })).sort((a, b) => a.k - b.k).map((x) => x.p);
  const slotKey = streamKey(tenant, 'streams', 'k');
  const racer = (i: number): Plan => ({ id: `race${i}`, policyRevision: 'r', route: 'r', chain: [], reservations: [], rateChecks: [], taint: null, preBlock: null, warnings: [], streamSlots: [{ limit: 'streams', key: slotKey, max: s.slots }] });
  const [settled, raced] = await Promise.all([Promise.all(order.map((p) => store.settle(p.id, 0))), Promise.all(Array.from({ length: s.slots + 2 }, (_, i) => store.admit(racer(i))))]);
  expect(settled.every((r) => r === 'settled')).toBe(true);
  // The racers never held more slots than exist.
  expect(raced.filter((a) => a.admitted).length).toBeLessThanOrEqual(s.slots);
  await Promise.all(raced.map((a, i) => (a.admitted ? store.settle(`race${i}`, 0) : null)));
  // Everything released: nothing reserved, every slot free.
  const key = ps[0]?.reservations[0]?.key as string;
  expect((await store.snapshot([key]))[key]).toEqual({ spent: 0, reserved: 0 });
  const again = await Promise.all(Array.from({ length: s.slots + 1 }, (_, i) => store.admit(racer(100 + i))));
  expect(again.map((a) => a.admitted)).toEqual([...Array.from({ length: s.slots }, () => true), false]);
  await Promise.all(again.map((a, i) => (a.admitted ? store.settle(`race${100 + i}`, 0) : null)));
}

/** Concurrent latch writes and reads: once a read sees the latch set, every later read does too. */
async function latch(store: CounterStore, ops: readonly boolean[]): Promise<void> {
  const reads: Array<Promise<boolean>> = [];
  const writes: Array<Promise<void>> = [];
  ops.forEach((w) => (w ? writes.push(store.latchBoundOff?.() ?? Promise.resolve()) : reads.push(store.boundOffLatched?.() ?? Promise.resolve(false))));
  const seen = await Promise.all(reads);
  await Promise.all(writes);
  const first = seen.indexOf(true);
  if (first >= 0) expect(seen.slice(first).every(Boolean)).toBe(true);
  if (writes.length > 0) expect(await store.boundOffLatched?.()).toBe(true);
}

const SEEDS = { batch: 0xc0c1, latch: 0xc0c2 };
const kinds = new Set<string>();

test('property (memory store): a batch of concurrent admits equals the sequential model in issue order; settling frees everything', async () => {
  await fc.assert(
    fc.asyncProperty(shape, fc.array(fc.nat(), { maxLength: 80 }), async (s, order) => {
      for (const k of model(s)) kinds.add(k);
      await batch(createMemoryStore({ clock: Date.now }), s, order);
    }),
    fuzz(SEEDS.batch, 200),
  );
  expect([...kinds].sort()).toEqual(['budget', 'ok', 'rate', 'sessions', 'streams']);
}, fuzzTimeout(20_000));

test('property (memory store): the R11 latch is monotone under concurrent writes and reads', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 40 }), async (ops) => latch(createMemoryStore({ clock: Date.now }), ops)), fuzz(SEEDS.latch, 100));
});

const url = process.env.REDIS_URL;
describe.skipIf(!url)('concurrent admits on Redis (REDIS_URL)', () => {
  const client = createClient({ url });
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.flushDb();
    await client.close();
  });

  test('property (redis store): a batch of concurrent admits equals the sequential model in issue order; settling frees everything', async () => {
    await fc.assert(
      fc.asyncProperty(shape, fc.array(fc.nat(), { maxLength: 80 }), async (s, order) => batch(createRedisStore(client, { deadlineMs: 600_000 }), s, order)),
      fuzz(SEEDS.batch, 40),
    );
  }, fuzzTimeout(60_000));

  test('property (redis store): two clients racing on one key never admit more than the limits allow', async () => {
    const second = createClient({ url });
    await second.connect();
    try {
      await fc.assert(
        fc.asyncProperty(shape, async (s) => {
          // Two connections: the interleaving is no longer the issue order, so only the bounds are exact.
          const a = createRedisStore(client, { deadlineMs: 600_000 });
          const b = createRedisStore(second, { deadlineMs: 600_000 });
          const { plans: ps } = plans(s);
          const res = await Promise.all(ps.map((p, i) => (i % 2 === 0 ? a : b).admit(p)));
          const ok = ps.filter((_, i) => res[i]?.admitted);
          expect(ok.filter((p) => p.rateChecks.length > 0).length).toBeLessThanOrEqual(s.burst);
          expect(ok.filter((p) => p.streamSlots.length > 0).length).toBeLessThanOrEqual(s.slots);
          expect(new Set(ok.flatMap((p) => (p.newSession ? [p.newSession.markerKey] : []))).size).toBeLessThanOrEqual(s.sessionBurst);
          expect(ok.reduce((x, p) => x + (p.reservations[0]?.estMicroUsd ?? 0), 0)).toBeLessThanOrEqual(s.limit);
          await Promise.all(ps.map((p, i) => (res[i]?.admitted ? (i % 2 === 0 ? a : b).settle(p.id, 0) : null)));
          const key = ps[0]?.reservations[0]?.key as string;
          expect((await a.snapshot([key]))[key]).toEqual({ spent: 0, reserved: 0 });
        }),
        fuzz(0xc0c3, 30),
      );
    } finally {
      await second.close();
    }
  }, fuzzTimeout(60_000));

  test('property (redis store): the R11 latch is monotone under concurrent writes and reads', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 40 }), async (ops) => {
        await client.del('ty:{_global}:r11');
        await latch(createRedisStore(client, { deadlineMs: 600_000 }), ops);
      }),
      fuzz(SEEDS.latch, 30),
    );
    await client.del('ty:{_global}:r11');
  }, fuzzTimeout(30_000));
});
