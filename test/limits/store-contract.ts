// Shared CounterStore contract (spec 7.1, 7.2, 7.4, 7.5, 6.6). Every implementation runs the same suite.
import { expect, test } from 'vitest';
import { budgetKey, gcraKey, streamKey, taintKey } from '../../src/limits/keys.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { Plan } from '../../src/policy/types.js';

const DAY = 86_400_000;
/** Past every store's reservation deadline (memory default 20 min, Redis tests 10 min), inside every window. */
const HOUR = 3_600_000;
let seq = 0;
/** A fresh tenant per test, so tests never see each other's counters. */
const freshTenant = (): string => `t${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const id = (): string => `req_${++seq}`;

type Reservation = Plan['reservations'][number];

function plan(over: Partial<Plan> = {}): Plan {
  return { id: id(), policyRevision: 'r1', route: 'r', chain: [], reservations: [], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [], ...over };
}

function level(tenant: string, name: string, limitMicroUsd: number, estMicroUsd: number, enforce = true, session = false): Reservation {
  const resetsAt = session ? null : new Date(Date.now() + DAY).toISOString();
  return { budget: name, key: budgetKey(tenant, name, 'v', session ? null : '2026-11-02'), limitMicroUsd, estMicroUsd, enforce, resetsAt };
}

export function runStoreContract(name: string, make: () => Promise<CounterStore>, listKeys?: (store: CounterStore) => Promise<string[]>): void {
  test(`${name}: admit reserves on every level and returns post-admit totals`, async () => {
    const s = await make();
    const t = freshTenant();
    const levels = [level(t, 'org', 10_000, 100), level(t, 'sess', 10_000, 100, true, true), level(t, 'aud', 10_000, 100, false)];
    const a = await s.admit(plan({ reservations: levels }));
    expect(a.admitted).toBe(true);
    expect(a.failed).toBeNull();
    expect(a.audit).toEqual([{ name: 'aud', wouldFail: false }]);
    expect(a.totals).toEqual([
      { key: levels[0]?.key, spentMicroUsd: 0, reservedMicroUsd: 100, limitMicroUsd: 10_000 },
      { key: levels[1]?.key, spentMicroUsd: 0, reservedMicroUsd: 100, limitMicroUsd: 10_000 },
    ]);
    const b = await s.admit(plan({ reservations: levels }));
    expect(b.totals.map((x) => x.reservedMicroUsd)).toEqual([200, 200]);
    const snap = await s.snapshot(levels.map((l) => l.key));
    for (const l of levels) expect(snap[l.key]).toEqual({ spent: 0, reserved: 200 });
  });

  test(`${name}: enforced level with spent + reserved + est > limit fails with kind budget; nothing written`, async () => {
    const s = await make();
    const t = freshTenant();
    const org = level(t, 'org', 200, 100);
    const other = level(t, 'other', 10_000, 100);
    await s.seed([{ key: org.key, spentMicroUsd: 40, ttlMs: DAY }]);
    const rate = { limit: 'rpm', key: gcraKey(t, 'rpm', 'k1'), emissionMs: 60_000, burst: 1, quantity: 1 };
    const slot = { limit: 'streams', key: streamKey(t, 'streams', 'k1'), max: 1 };
    expect((await s.admit(plan({ reservations: [org, other] }))).admitted).toBe(true);
    // 40 + 0 + 100 = 140 <= 200 fits; 40 + 100 + 100 = 240 does not.
    const fail = await s.admit(plan({ reservations: [org, other], rateChecks: [rate], streamSlots: [slot] }));
    expect(fail.admitted).toBe(false);
    expect(fail.failed).toEqual({ kind: 'budget', name: 'org', spentMicroUsd: 40 });
    // What the failing admit saw: spent + reserved + est > limit.
    expect(fail.totals.find((x) => x.key === org.key)).toEqual({ key: org.key, spentMicroUsd: 40, reservedMicroUsd: 100, limitMicroUsd: 200 });
    const snap = await s.snapshot([org.key, other.key]);
    expect(snap[org.key]).toEqual({ spent: 40, reserved: 100 });
    expect(snap[other.key]).toEqual({ spent: 0, reserved: 100 });
    // The failed admit consumed neither the rate check nor the stream slot.
    expect((await s.admit(plan({ rateChecks: [rate], streamSlots: [slot] }))).admitted).toBe(true);
  });

  test(`${name}: audit level that would fail is reported in audit and still reserved`, async () => {
    const s = await make();
    const t = freshTenant();
    const aud = level(t, 'aud', 50, 100, false);
    const org = level(t, 'org', 10_000, 100);
    const a = await s.admit(plan({ reservations: [org, aud] }));
    expect(a.admitted).toBe(true);
    expect(a.audit).toEqual([{ name: 'aud', wouldFail: true }]);
    expect(a.totals.map((x) => x.key)).toEqual([org.key]);
    expect((await s.snapshot([aud.key]))[aud.key]).toEqual({ spent: 0, reserved: 100 });
  });

  test(`${name}: duplicate admit for the same id makes no second reservation`, async () => {
    const s = await make();
    const t = freshTenant();
    const org = level(t, 'org', 10_000, 100);
    const p = plan({ reservations: [org] });
    const rid = id();
    expect((await s.admit({ ...p, id: rid })).admitted).toBe(true);
    const again = await s.admit({ ...p, id: rid });
    expect(again.admitted).toBe(true);
    expect((await s.snapshot([org.key]))[org.key]).toEqual({ spent: 0, reserved: 100 });
  });

  test(`${name}: settle replaces reserved with actual and is idempotent (second call returns unknown)`, async () => {
    const s = await make();
    const t = freshTenant();
    const levels = [level(t, 'org', 10_000, 100), level(t, 'aud', 10, 100, false)];
    const rid = id();
    await s.admit({ ...plan({ reservations: levels }), id: rid });
    expect(await s.settle(rid, 30)).toBe('settled');
    const snap = await s.snapshot(levels.map((l) => l.key));
    for (const l of levels) expect(snap[l.key]).toEqual({ spent: 30, reserved: 0 });
    expect(await s.settle(rid, 30)).toBe('unknown');
    expect(await s.settle('never-admitted', 30)).toBe('unknown');
    expect((await s.snapshot([levels[0]?.key as string]))[levels[0]?.key as string]).toEqual({ spent: 30, reserved: 0 });
  });

  test(`${name}: GCRA: burst then retryAfterMs; a check with quantity q consumes q emission intervals`, async () => {
    const s = await make();
    const t = freshTenant();
    const rpm = (quantity: number) => ({ limit: 'rpm', key: gcraKey(t, 'rpm', 'k1'), emissionMs: 60_000, burst: 3, quantity });
    const org = level(t, 'org', 10_000, 100);
    expect((await s.admit(plan({ rateChecks: [rpm(2)] }))).admitted).toBe(true);
    expect((await s.admit(plan({ rateChecks: [rpm(1)] }))).admitted).toBe(true);
    const denied = await s.admit(plan({ rateChecks: [rpm(1)], reservations: [org] }));
    expect(denied.admitted).toBe(false);
    expect(denied.failed?.kind).toBe('rate');
    expect(denied.failed?.name).toBe('rpm');
    expect(denied.failed?.retryAfterMs).toBeGreaterThan(55_000);
    expect(denied.failed?.retryAfterMs).toBeLessThanOrEqual(60_000);
    // A rate failure reserves nothing.
    expect((await s.snapshot([org.key]))[org.key]).toEqual({ spent: 0, reserved: 0 });
    // Burst 1 on a fresh key: one at once.
    const one = { limit: 'one', key: gcraKey(t, 'one', 'k1'), emissionMs: 60_000, burst: 1, quantity: 1 };
    expect((await s.admit(plan({ rateChecks: [one] }))).admitted).toBe(true);
    expect((await s.admit(plan({ rateChecks: [one] }))).failed?.kind).toBe('rate');
  });

  test(`${name}: stream slots: max reached fails kind streams; settle and sweep free the slot`, async () => {
    const s = await make();
    const t = freshTenant();
    const slot = { limit: 'streams', key: streamKey(t, 'streams', 'k1'), max: 2 };
    const p = (rid: string) => ({ ...plan({ streamSlots: [slot] }), id: rid });
    const [a, b, c, d, e] = [id(), id(), id(), id(), id()];
    expect((await s.admit(p(a))).admitted).toBe(true);
    expect((await s.admit(p(b))).admitted).toBe(true);
    expect((await s.admit(p(c))).failed).toEqual({ kind: 'streams', name: 'streams' });
    expect(await s.settle(a, 0)).toBe('settled');
    expect((await s.admit(p(c))).admitted).toBe(true);
    expect((await s.admit(p(d))).failed?.kind).toBe('streams');
    expect(await s.sweep(Date.now() + HOUR)).toBe(2);
    expect((await s.admit(p(d))).admitted).toBe(true);
    expect((await s.admit(p(e))).admitted).toBe(true);
    expect((await s.admit(p(id()))).failed?.kind).toBe('streams');
  });

  test(`${name}: taint add writes the HMAC with TTL and nothing else; later check with that HMAC fails kind taint`, async () => {
    const s = await make();
    const t = freshTenant();
    const key = taintKey(t, 's1');
    const org = level(t, 'org', 10_000, 100);
    const write = await s.admit(plan({ preBlock: 'secret', taint: { key, check: [], add: [{ rule: 'gh', valueHmac: 'h1' }], ttlMs: 60_000 } }));
    expect(write.admitted).toBe(false);
    expect(write.failed).toMatchObject({ kind: 'taint', rule: 'gh' });
    if (listKeys) expect(await listKeys(s)).toEqual([key]);
    const later = await s.admit(plan({ reservations: [org], taint: { key, check: ['h0', 'h1'], add: [], ttlMs: 60_000 } }));
    expect(later.admitted).toBe(false);
    expect(later.failed).toMatchObject({ kind: 'taint', rule: 'gh' });
    expect((await s.snapshot([org.key]))[org.key]).toEqual({ spent: 0, reserved: 0 });
    // A different HMAC, or the same HMAC in another session, passes.
    expect((await s.admit(plan({ reservations: [org], taint: { key, check: ['h2'], add: [], ttlMs: 60_000 } }))).admitted).toBe(true);
    expect((await s.admit(plan({ taint: { key: taintKey(t, 's2'), check: ['h1'], add: [], ttlMs: 60_000 } }))).admitted).toBe(true);
  });

  test(`${name}: sweep settles overdue reservations at the estimate`, async () => {
    const s = await make();
    const t = freshTenant();
    const levels = [level(t, 'org', 10_000, 100), level(t, 'sess', 10_000, 100, true, true)];
    const rid = id();
    await s.admit({ ...plan({ reservations: levels }), id: rid });
    expect(await s.sweep(Date.now())).toBe(0);
    expect(await s.sweep(Date.now() + HOUR)).toBe(1);
    const snap = await s.snapshot(levels.map((l) => l.key));
    for (const l of levels) expect(snap[l.key]).toEqual({ spent: 100, reserved: 0 });
    expect(await s.settle(rid, 5)).toBe('unknown');
    expect(await s.sweep(Date.now() + HOUR)).toBe(0);
  });

  test(`${name}: seed sets spent for warm-up keys`, async () => {
    const s = await make();
    const t = freshTenant();
    const org = level(t, 'org', 650, 100);
    await s.seed([{ key: org.key, spentMicroUsd: 700, ttlMs: DAY }]);
    expect((await s.snapshot([org.key]))[org.key]).toEqual({ spent: 700, reserved: 0 });
    await s.seed([{ key: org.key, spentMicroUsd: 600, ttlMs: DAY }]);
    expect((await s.snapshot([org.key]))[org.key]).toEqual({ spent: 600, reserved: 0 });
    expect((await s.admit(plan({ reservations: [org] }))).failed).toEqual({ kind: 'budget', name: 'org', spentMicroUsd: 600 });
    expect(await s.snapshot(['ty:{nobody}:b:x:y'])).toEqual({ 'ty:{nobody}:b:x:y': { spent: 0, reserved: 0 } });
  });

  test(`${name}: every key the store writes contains {tenant}`, async () => {
    const s = await make();
    const tenant = `a{b}c:${freshTenant()}`;
    const tag = `ty:{${encodeURIComponent(tenant)}}:`;
    const rid = id();
    const full = plan({
      reservations: [level(tenant, 'org', 10_000, 100), level(tenant, 'sess', 10_000, 100, true, true), level(tenant, 'aud', 10, 100, false)],
      rateChecks: [{ limit: 'rpm', key: gcraKey(tenant, 'rpm', 'k1'), emissionMs: 1_000, burst: 5, quantity: 1 }],
      streamSlots: [{ limit: 'streams', key: streamKey(tenant, 'streams', 'k1'), max: 5 }],
      taint: { key: taintKey(tenant, 's1'), check: ['h9'], add: [], ttlMs: 60_000 },
    });
    expect((await s.admit({ ...full, id: rid })).admitted).toBe(true);
    expect((await s.admit({ ...full, id: id() })).admitted).toBe(true);
    await s.admit(plan({ preBlock: 'secret', taint: { key: taintKey(tenant, 's1'), check: [], add: [{ rule: 'gh', valueHmac: 'h9' }], ttlMs: 60_000 } }));
    await s.settle(rid, 10);
    await s.seed([{ key: budgetKey(tenant, 'org', 'v', '2026-11-01'), spentMicroUsd: 5, ttlMs: DAY }]);
    if (!listKeys) return;
    const keys = await listKeys(s);
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(k.startsWith(tag)).toBe(true);
    // Keys of an admit for another tenant never land under this tenant's tag.
    await expect(s.admit(plan({ reservations: [level(tenant, 'org', 10_000, 1)], streamSlots: [{ limit: 'x', key: streamKey('other', 'x', 'k'), max: 1 }] }))).rejects.toThrow(/tenant/);
  });

  test(`${name}: concurrent admits never reserve past an enforced limit`, async () => {
    const s = await make();
    const t = freshTenant();
    const org = level(t, 'org', 1_000, 100);
    const results = await Promise.all(Array.from({ length: 40 }, () => s.admit(plan({ reservations: [org] }))));
    expect(results.filter((r) => r.admitted)).toHaveLength(10);
    for (const r of results) for (const x of r.totals) if (r.admitted) expect(x.spentMicroUsd + x.reservedMicroUsd).toBeLessThanOrEqual(x.limitMicroUsd);
    expect((await s.snapshot([org.key]))[org.key]).toEqual({ spent: 0, reserved: 1_000 });
  });

  test(`${name}: a plan with no counter keys is admitted without writing`, async () => {
    const s = await make();
    const a = await s.admit(plan());
    expect(a).toEqual({ admitted: true, failed: null, audit: [], totals: [] });
    if (listKeys) expect(await listKeys(s)).toEqual([]);
  });
}
