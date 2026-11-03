// In-memory counter store (spec 7.1): one instance, demo, tests and the replay sim store. `admit` is atomic because
// Node runs it on one thread and it never awaits: every check and every write happen in one synchronous section.
// All state lives in Maps, so a key or id such as `__proto__` is just a string.
import type { Admission, Plan } from '../policy/types.js';
import { gcra } from './gcra.js';
import { deadlinesKey, r11LatchKey, reservationKey, tenantOfKey } from './keys.js';
import { assertMicroUsd, budgetExpiresAt, type CounterStore, DEFAULT_DEADLINE_MS, planTenant } from './store.js';

interface Expiring {
  /** ms since epoch; the entry is gone from this moment on. */
  exp: number;
}
interface Budget extends Expiring {
  s: number;
  r: number;
}
interface Tat extends Expiring {
  tat: number;
}
interface Taint extends Expiring {
  /** value HMAC to the rule that blocked it */
  rules: Map<string, string>;
}
interface Reservation {
  tenant: string;
  levels: Array<{ key: string; est: number }>;
  streams: string[];
  deadline: number;
}

export interface MemoryCounterStore extends CounterStore {
  /** Every live key, named as the Redis store would name it (tests: every key carries `{tenant}`). */
  keys(): string[];
}

const NOTHING: Admission = { admitted: true, failed: null, audit: [], totals: [] };
const refused = (failed: NonNullable<Admission['failed']>): Admission => ({ admitted: false, failed, audit: [], totals: [] });

/** `onSwept` receives the ids of the reservations a sweep settled at their estimate (trace `settledBy: sweeper`). */
export function createMemoryStore(o: { clock(): number; deadlineMs?: number; onSwept?: (ids: string[]) => void }): MemoryCounterStore {
  const deadlineMs = o.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const budgets = new Map<string, Budget>();
  const tats = new Map<string, Tat>();
  const streams = new Map<string, number>();
  const taints = new Map<string, Taint>();
  const reservations = new Map<string, Reservation>();
  let r11 = false;

  function live<V extends Expiring>(m: Map<string, V>, key: string, now: number): V | undefined {
    const v = m.get(key);
    if (v !== undefined && v.exp <= now) {
      m.delete(key);
      return undefined;
    }
    return v;
  }

  /** Settle one reservation: each level's reserved estimate becomes `actual(est)` spent; stream slots are freed. */
  function release(id: string, res: Reservation, actual: (est: number) => number, now: number): void {
    for (const l of res.levels) {
      // A key that already expired (its window is long over) is not recreated.
      const b = live(budgets, l.key, now);
      if (b === undefined) continue;
      b.r -= l.est;
      b.s += actual(l.est);
    }
    for (const key of res.streams) {
      const n = streams.get(key) ?? 0;
      if (n <= 1) streams.delete(key);
      else streams.set(key, n - 1);
    }
    reservations.delete(id);
  }

  function admitNow(plan: Plan, now: number): Admission {
    const tenant = planTenant(plan);
    if (tenant === null) return NOTHING;
    // A duplicate admit for this id is refused: answering admitted would forward it without a reservation of its own.
    if (reservations.has(plan.id)) return refused({ kind: 'duplicate', name: 'duplicate' });

    // 0) Taint. A last-turn block writes its HMACs and nothing else; otherwise any history HMAC in the set blocks.
    const t = plan.taint;
    if (t !== null) {
      const first = t.add[0];
      if (first !== undefined) {
        let set = live(taints, t.key, now);
        if (set === undefined) {
          set = { exp: 0, rules: new Map() };
          taints.set(t.key, set);
        }
        for (const a of t.add) set.rules.set(a.valueHmac, a.rule);
        set.exp = now + t.ttlMs;
        return refused({ kind: 'taint', name: 'taint', rule: first.rule });
      }
      const set = live(taints, t.key, now);
      for (const h of t.check) {
        const rule = set?.rules.get(h);
        if (rule !== undefined) return refused({ kind: 'taint', name: 'taint', rule, valueHmac: h });
      }
    }

    // 1) GCRA checks: the first failing limit refuses, nothing written.
    const nextTats: number[] = [];
    for (const c of plan.rateChecks) {
      const g = gcra(live(tats, c.key, now)?.tat ?? null, now, c.emissionMs, c.burst, c.quantity);
      if (!g.allowed) return refused({ kind: 'rate', name: c.limit, retryAfterMs: g.retryAfterMs });
      nextTats.push(g.tatMs);
    }

    // 2) Stream slots.
    for (const s of plan.streamSlots) if ((streams.get(s.key) ?? 0) >= s.max) return refused({ kind: 'streams', name: s.limit });

    // 3) Budgets: enforced levels refuse when spent + reserved + est > limit; audit levels are only reported.
    const seen = plan.reservations.map((l) => {
      const b = live(budgets, l.key, now);
      return { s: b?.s ?? 0, r: b?.r ?? 0 };
    });
    const audit: Admission['audit'] = [];
    let failing = -1;
    plan.reservations.forEach((l, i) => {
      const { s, r } = seen[i] as { s: number; r: number };
      const over = s + r + l.estMicroUsd > l.limitMicroUsd;
      if (!l.enforce) audit.push({ name: l.budget, wouldFail: over });
      else if (over && failing < 0) failing = i;
    });
    const totals = (): Admission['totals'] =>
      plan.reservations.flatMap((l, i) => {
        if (!l.enforce) return [];
        const { s, r } = seen[i] as { s: number; r: number };
        return [{ key: l.key, spentMicroUsd: s, reservedMicroUsd: r, limitMicroUsd: l.limitMicroUsd }];
      });
    const fail = plan.reservations[failing];
    if (fail !== undefined) {
      return { admitted: false, failed: { kind: 'budget', name: fail.budget, spentMicroUsd: seen[failing]?.s ?? 0 }, audit, totals: totals() };
    }

    // 4) All passed: reserve on every level (audit ones too), take the slots, move the TATs, record the reservation.
    plan.reservations.forEach((l, i) => {
      let b = live(budgets, l.key, now);
      if (b === undefined) {
        b = { s: 0, r: 0, exp: 0 };
        budgets.set(l.key, b);
      }
      b.r += l.estMicroUsd;
      b.exp = budgetExpiresAt(l.resetsAt, now);
      (seen[i] as { r: number }).r = b.r;
    });
    plan.rateChecks.forEach((c, i) => {
      const tat = nextTats[i] as number;
      tats.set(c.key, { tat, exp: tat });
    });
    for (const s of plan.streamSlots) streams.set(s.key, (streams.get(s.key) ?? 0) + 1);
    reservations.set(plan.id, {
      tenant,
      levels: plan.reservations.map((l) => ({ key: l.key, est: l.estMicroUsd })),
      streams: plan.streamSlots.map((s) => s.key),
      deadline: now + deadlineMs,
    });
    return { admitted: true, failed: null, audit, totals: totals() };
  }

  return {
    async admit(plan, nowMs) {
      return admitNow(plan, nowMs ?? o.clock());
    },

    // `perLevel` is accepted for the spec 7.1 signature; the actual cost is applied to every level either way.
    async settle(id, actualMicroUsd) {
      assertMicroUsd(actualMicroUsd, 'actual cost');
      const res = reservations.get(id);
      if (res === undefined) return 'unknown';
      release(id, res, () => actualMicroUsd, o.clock());
      return 'settled';
    },

    async sweep(nowMs) {
      const ids: string[] = [];
      for (const [id, res] of reservations) {
        if (res.deadline > nowMs) continue;
        release(id, res, (est) => est, nowMs);
        ids.push(id);
      }
      if (ids.length > 0) o.onSwept?.(ids);
      for (const m of [budgets, tats, taints] as Array<Map<string, Expiring>>) for (const key of m.keys()) live(m, key, nowMs);
      return ids.length;
    },

    async snapshot(keys) {
      const now = o.clock();
      // fromEntries defines own properties, so a key named __proto__ stays a key.
      return Object.fromEntries(
        keys.map((key) => {
          const b = live(budgets, key, now);
          return [key, { spent: b?.s ?? 0, reserved: b?.r ?? 0 }];
        }),
      );
    },

    async seed(entries) {
      const now = o.clock();
      for (const e of entries) {
        if (tenantOfKey(e.key) === null) throw new Error(`counter key without a tenant tag: ${e.key}`);
        assertMicroUsd(e.spentMicroUsd, 'seeded spend');
        if (e.ttlMs <= 0) continue;
        let b = live(budgets, e.key, now);
        if (b === undefined) {
          b = { s: 0, r: 0, exp: 0 };
          budgets.set(e.key, b);
        }
        // max(current, seeded), TTL only grows: seeding from partial traces never lowers spend (as the Redis store).
        b.s = Math.max(b.s, e.spentMicroUsd);
        b.exp = Math.max(b.exp, now + e.ttlMs);
      }
    },

    async latchBoundOff() {
      r11 = true;
    },

    async boundOffLatched() {
      return r11;
    },

    keys() {
      const now = o.clock();
      const out = new Set<string>();
      if (r11) out.add(r11LatchKey());
      for (const m of [budgets, tats, taints] as Array<Map<string, Expiring>>) for (const key of m.keys()) if (live(m, key, now)) out.add(key);
      for (const key of streams.keys()) out.add(key);
      for (const [id, res] of reservations) {
        out.add(reservationKey(res.tenant, id));
        out.add(deadlinesKey(res.tenant));
      }
      return [...out].sort();
    },
  };
}
