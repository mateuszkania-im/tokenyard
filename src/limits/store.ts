// Spec 7.1 counter store interface, plus what the memory and Redis stores share: key lifetimes and plan validation.
import type { Admission, Plan } from '../policy/types.js';
import { tenantOfKey } from './keys.js';

export interface CounterStore {
  admit(plan: Plan, nowMs?: number): Promise<Admission>;          // atomic: rate checks, stream slots, taint, all reservations
  settle(id: string, actualMicroUsd: number, perLevel?: boolean): Promise<'settled' | 'unknown'>;  // idempotent; releases the stream slot
  sweep(nowMs: number): Promise<number>;                            // settles overdue reservations and frees their slots
  snapshot(keys: string[]): Promise<Record<string, { spent: number; reserved: number }>>;
  seed(entries: Array<{ key: string; spentMicroUsd: number; ttlMs: number }>): Promise<void>;  // warm-up from traces (9.2, 14.1)
  /** Not in spec 7.1: sets the shared R11 latch (`ty:{_global}:r11`), so every instance, restarts included, drops the bytes bound (A9). */
  latchBoundOff?(): Promise<void>;
  /** Not in spec 7.1: whether the shared R11 latch is set. */
  boundOffLatched?(): Promise<boolean>;
}

const DAY_MS = 86_400_000;
/** A window budget key lives one day past its window's end: longer than any reservation, so a late settle still lands. */
export const WINDOW_GRACE_MS = DAY_MS;
/** A session budget has no window; its key expires 30 days after the session's last admit. */
export const SESSION_BUDGET_TTL_MS = 30 * DAY_MS;
/** Reservation deadline of the memory store when none is given: 2 times a 10 minute request timeout (spec 7.2). */
export const DEFAULT_DEADLINE_MS = 20 * 60_000;

/** When a budget key expires (ms since epoch): `resetsAt` plus the grace, or now plus the session TTL. */
export function budgetExpiresAt(resetsAt: string | null, nowMs: number): number {
  return resetsAt === null ? nowMs + SESSION_BUDGET_TTL_MS : Date.parse(resetsAt) + WINDOW_GRACE_MS;
}

const isMicro = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Throws unless `n` is a non-negative safe integer: money is integer micro-USD, never a float (global constraint). */
export function assertMicroUsd(n: number, what: string): void {
  if (!isMicro(n)) throw new Error(`${what} must be a non-negative integer number of micro-USD, got ${n}`);
}

/**
 * The tenant all counter keys of a plan share, or null when the plan has none (nothing to check or reserve).
 * Throws when a key is not `ty:{tenant}:` tagged or the keys span tenants: one admit is one tenant, one cluster slot.
 */
export function planTenant(plan: Plan): string | null {
  const keys = [
    ...plan.reservations.map((r) => r.key),
    ...plan.rateChecks.map((r) => r.key),
    ...plan.streamSlots.map((s) => s.key),
    ...(plan.taint ? [plan.taint.key] : []),
  ];
  let tenant: string | null = null;
  for (const key of keys) {
    const t = tenantOfKey(key);
    if (t === null) throw new Error(`counter key without a tenant tag: ${key}`);
    if (tenant !== null && t !== tenant) throw new Error('plan keys span more than one tenant');
    tenant = t;
  }
  for (const r of plan.reservations) {
    assertMicroUsd(r.estMicroUsd, `reservation ${r.budget} estimate`);
    assertMicroUsd(r.limitMicroUsd, `budget ${r.budget} limit`);
  }
  return tenant;
}
