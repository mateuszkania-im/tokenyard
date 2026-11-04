// V4 properties of the counter stores (spec 7.1, 7.2, 7.4). Random sequences of admits (several budget levels, audit
// levels, a rate check, a stream slot, a session, taint), settles (actual up to the estimate, repeated settles) and
// duplicate ids, applied in order:
//  - on every store: no enforced level ever has spent + reserved above its limit; every amount is a non-negative safe
//    integer; spent is exactly the sum of what was settled on that level; once every reservation is settled nothing
//    stays reserved and every stream slot is free again; a fractional or negative settle throws;
//  - the memory store and the Redis store return the same admission (retry-after aside) and the same counters for the
//    same sequence (Redis only with REDIS_URL: `npm run test:redis`, scripts/local-redis.mjs, loopback only).
import fc from 'fast-check';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { budgetKey, gcraKey, newSessionsKey, sessionKey, streamKey, taintKey } from '../../src/limits/keys.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { createRedisStore } from '../../src/limits/redis-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { Admission, Plan } from '../../src/policy/types.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LEVELS = [
  { name: 'org', limit: 1_200, enforce: true, session: false },
  { name: 'team', limit: 500, enforce: true, session: false },
  { name: 'sess', limit: 400, enforce: true, session: true },
  { name: 'aud', limit: 200, enforce: false, session: false },
] as const;
const SLOT_MAX = 2;
const RATE_BURST = 6;
const SESSION_BURST = 3;

type Op =
  | { kind: 'admit'; est: number; levels: boolean[]; rate: boolean; slot: boolean; session: number | null; taintAdd: number | null; taintCheck: number | null; dup: number | null }
  | { kind: 'settle'; target: number; frac: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant('admit' as const),
    est: fc.oneof({ weight: 5, arbitrary: fc.noBias(fc.integer({ min: 0, max: 400 })) }, { weight: 1, arbitrary: fc.constant(0) }),
    levels: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    rate: fc.boolean(),
    slot: fc.boolean(),
    session: fc.option(fc.nat(4), { freq: 2, nil: null }),
    taintAdd: fc.option(fc.nat(2), { freq: 8, nil: null }),
    taintCheck: fc.option(fc.nat(2), { freq: 4, nil: null }),
    dup: fc.option(fc.nat(30), { freq: 10, nil: null }),
  }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('settle' as const), target: fc.nat(40), frac: fc.double({ min: 0, max: 1, noNaN: true }) }) },
);

let runs = 0;
interface Run {
  tenant: string;
  keys: string[];
  plan(o: Extract<Op, { kind: 'admit' }>, id: string): Plan;
}
function newRun(prefix: string): Run {
  const tenant = `${prefix}${++runs}-${Math.random().toString(36).slice(2, 8)}`;
  const keyOf = (l: (typeof LEVELS)[number], session: string): string => budgetKey(tenant, l.name, l.session ? session : 'v', l.session ? null : '2026-11-03');
  return {
    tenant,
    keys: [...LEVELS.filter((l) => !l.session).map((l) => keyOf(l, '')), ...[0, 1, 2, 3, 4].map((s) => keyOf(LEVELS[2], `s${s}`))],
    plan(o, id) {
      const session = o.session === null ? null : `s${o.session}`;
      const reservations = LEVELS.flatMap((l, i) =>
        !o.levels[i] || (l.session && session === null)
          ? []
          : [{ budget: l.name, key: keyOf(l, session ?? ''), limitMicroUsd: l.limit, estMicroUsd: o.est, enforce: l.enforce, resetsAt: l.session ? null : new Date(Date.now() + DAY).toISOString() }],
      );
      const taintOn = session !== null && (o.taintAdd !== null || o.taintCheck !== null);
      return {
        id, policyRevision: 'r', route: 'r', chain: [], preBlock: o.taintAdd !== null ? 'secret' : null, warnings: [],
        reservations,
        rateChecks: o.rate ? [{ limit: 'rpm', key: gcraKey(tenant, 'rpm', 'k1'), emissionMs: HOUR, burst: RATE_BURST, quantity: 1 }] : [],
        streamSlots: o.slot ? [{ limit: 'streams', key: streamKey(tenant, 'streams', 'k1'), max: SLOT_MAX }] : [],
        taint: taintOn ? { key: taintKey(tenant, session as string), check: o.taintCheck === null ? [] : [`h${o.taintCheck}`], add: o.taintAdd === null ? [] : [{ rule: 'gh', valueHmac: `h${o.taintAdd}` }], ttlMs: HOUR } : null,
        newSession: session === null ? null : { limit: 'new-sessions', markerKey: sessionKey(tenant, session), key: newSessionsKey(tenant, 'k1'), emissionMs: HOUR / SESSION_BURST, burst: SESSION_BURST, ttlMs: DAY },
      };
    },
  };
}

/** Admission without the clock-dependent retry-after. */
const comparable = (a: Admission): unknown => ({ ...a, failed: a.failed ? { ...a.failed, retryAfterMs: a.failed.retryAfterMs === undefined ? undefined : 'set' } : null });

type Trace = { admissions: unknown[]; snapshots: unknown[]; settles: string[] };
/** Refusal kinds seen across all runs: the generators must reach each one. */
const kindsSeen = new Set<string>();

/** Applies `ops` in order, checking the invariants after each, and returns what a second store must reproduce. */
async function apply(store: CounterStore, run: Run, ops: readonly Op[]): Promise<Trace> {
  const open: Array<{ id: string; est: number; levels: string[] }> = [];
  const settled = new Map<string, number>(); // key: sum of actuals settled on it
  const out: Trace = { admissions: [], snapshots: [], settles: [] };
  const enforcedLimit = new Map<string, number>();
  for (const [i, o] of ops.entries()) {
    if (o.kind === 'admit') {
      // A duplicate reuses the id of a reservation still open (the gateway never reuses ids; a settled id is free again).
      const id = o.dup !== null && open.length > 0 ? (open[o.dup % open.length] as { id: string }).id : `r${i}`;
      const plan = run.plan(o, id);
      for (const r of plan.reservations) if (r.enforce) enforcedLimit.set(r.key, r.limitMicroUsd);
      const a = await store.admit(plan);
      out.admissions.push(comparable(a));
      kindsSeen.add(a.failed?.kind ?? 'admitted');
      const touches = plan.reservations.length + plan.rateChecks.length + plan.streamSlots.length > 0 || plan.taint !== null || plan.newSession !== null;
      // A plan with no key touches nothing (admitted, no record); any other plan under an open id is a duplicate.
      if (touches && open.some((x) => x.id === id)) expect(a.failed?.kind).toBe('duplicate');
      for (const t of a.totals) for (const n of [t.spentMicroUsd, t.reservedMicroUsd]) expect(Number.isSafeInteger(n) && n >= 0).toBe(true);
      if (a.admitted && touches) {
        expect(open.map((x) => x.id)).not.toContain(id); // an id with an open reservation is never admitted again
        open.push({ id, est: o.est, levels: plan.reservations.map((r) => r.key) });
        // The post-admit totals of an admitted request respect every enforced limit.
        for (const t of a.totals) expect(t.spentMicroUsd + t.reservedMicroUsd).toBeLessThanOrEqual(t.limitMicroUsd);
      }
    } else {
      const t = open.length > 0 ? open[o.target % open.length] : undefined;
      if (!t) continue;
      const actual = Math.floor(t.est * o.frac);
      const r = await store.settle(t.id, actual);
      out.settles.push(r);
      if (r === 'settled') {
        open.splice(open.indexOf(t), 1);
        for (const k of t.levels) settled.set(k, (settled.get(k) ?? 0) + actual);
      }
      // Settling again is a no-op.
      expect(await store.settle(t.id, actual)).toBe(r === 'settled' ? 'unknown' : r);
    }
    const snap = await store.snapshot(run.keys);
    out.snapshots.push(snap);
    for (const [k, v] of Object.entries(snap)) {
      expect(Number.isSafeInteger(v.spent) && v.spent >= 0 && Number.isSafeInteger(v.reserved) && v.reserved >= 0).toBe(true);
      expect(v.spent).toBe(settled.get(k) ?? 0);
      const limit = enforcedLimit.get(k);
      if (limit !== undefined) expect(v.spent + v.reserved).toBeLessThanOrEqual(limit);
    }
  }
  // Settle everything still open: nothing stays reserved and every stream slot is free.
  for (const t of open) expect(await store.settle(t.id, 0)).toBe('settled');
  const snap = await store.snapshot(run.keys);
  for (const v of Object.values(snap)) expect(v.reserved).toBe(0);
  const slot = (n: number): Plan => ({ id: `slot-${n}`, policyRevision: 'r', route: 'r', chain: [], reservations: [], rateChecks: [], taint: null, preBlock: null, warnings: [], streamSlots: [{ limit: 'streams', key: streamKey(run.tenant, 'streams', 'k1'), max: SLOT_MAX }] });
  for (let n = 0; n < SLOT_MAX; n++) expect((await store.admit(slot(n))).admitted).toBe(true);
  expect((await store.admit(slot(SLOT_MAX))).failed?.kind).toBe('streams');
  for (let n = 0; n < SLOT_MAX; n++) await store.settle(`slot-${n}`, 0);
  return out;
}

const ops = fc.array(opArb, { minLength: 1, maxLength: 40, size: 'max' });

test('property (memory store): limits hold, amounts are integers, spent equals settled sums, everything is released', async () => {
  await fc.assert(
    fc.asyncProperty(ops, async (xs) => {
      await apply(createMemoryStore({ clock: Date.now }), newRun('m'), xs);
    }),
    fuzz(0x570e, 200),
  );
  expect([...kindsSeen].sort()).toEqual(['admitted', 'budget', 'duplicate', 'rate', 'sessions', 'streams', 'taint']);
}, fuzzTimeout(20_000));

test('property (memory store): a fractional, negative or unsafe settle throws and changes nothing', async () => {
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.double({ min: 0.001, max: 1e6, noInteger: true }), fc.integer({ max: -1 }), fc.constantFrom(Number.NaN, Infinity, 2 ** 53)), async (bad) => {
      const s = createMemoryStore({ clock: Date.now });
      const run = newRun('f');
      const plan = run.plan({ kind: 'admit', est: 100, levels: [true, false, false, false], rate: false, slot: false, session: null, taintAdd: null, taintCheck: null, dup: null }, 'x');
      expect((await s.admit(plan)).admitted).toBe(true);
      await expect(s.settle('x', bad)).rejects.toThrow(/micro-USD/);
      expect((await s.snapshot([run.keys[0] as string]))[run.keys[0] as string]).toEqual({ spent: 0, reserved: 100 });
      expect(await s.settle('x', 40)).toBe('settled');
    }),
    fuzz(0x570f, 100),
  );
});

const url = process.env.REDIS_URL;
describe.skipIf(!url)('memory and Redis stores agree (REDIS_URL)', () => {
  const client = createClient({ url });
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.flushDb();
    await client.close();
  });

  test('property: the same sequence gives the same admissions and counters on both stores, and the invariants hold on Redis', async () => {
    await fc.assert(
      fc.asyncProperty(ops, async (xs) => {
        const memory = await apply(createMemoryStore({ clock: Date.now }), newRun('am'), xs);
        const redis = await apply(createRedisStore(client, { deadlineMs: 600_000 }), newRun('ar'), xs);
        // Keys differ only by tenant: compare the values in key order.
        const values = (t: Trace): unknown => ({ ...t, snapshots: t.snapshots.map((s) => Object.values(s as object)), admissions: t.admissions.map((a) => JSON.parse(JSON.stringify(a).replace(/ty:\{a[mr]\d+-[a-z0-9]+\}/g, 'ty:{t}'))) });
        expect(values(redis)).toEqual(values(memory));
      }),
      fuzz(0x570d, 40),
    );
  }, fuzzTimeout(60_000));
});
