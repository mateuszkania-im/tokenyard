// Warm-up (spec 9.2 step 6, 14.1): the spend recorded in traces, summed per budget key, for the budget windows that
// contain `nowMs`, so a restarted gateway (or the live harness) starts from what was already spent. Keys and scope
// values are derived exactly as `decide` derives them, "(unattributed)" for a missing header included.
import type { LedgerLine, ReservedRecord } from '../ledger/record.js';
import { budgetEnforced, levelValue, windowOf } from '../policy/decide.js';
import type { CompiledPolicy } from '../policy/types.js';
import { budgetKey } from './keys.js';
import { budgetExpiresAt } from './store.js';

export async function warmupEntries(records: AsyncIterable<LedgerLine>, policy: CompiledPolicy, nowMs: number): Promise<Array<{ key: string; spentMicroUsd: number; ttlMs: number }>> {
  const current = new Map(policy.budgets.flatMap((b) => (b.window === null ? [] : [[b.window, windowOf(b.window, nowMs)] as const])));
  const sums = new Map<string, { spent: number; expiresAt: number }>();
  // Write-ahead lines (A11) count until the request line with the same id is seen, whichever comes first in the files.
  const settled = new Set<string>();
  const pending = new Map<string, ReservedRecord>();
  for await (const r of records) {
    if (r.kind === 'reserved') {
      if (!settled.has(r.id)) pending.set(r.id, r);
      continue;
    }
    if (r.kind !== 'request') continue;
    settled.add(r.id);
    pending.delete(r.id);
    // What the store charged (the estimate when the sweeper settled); older traces and requests without a reservation have only the cost.
    add(r, r.outcome.chargedMicroUsd ?? r.outcome.costMicroUsd);
  }
  for (const r of pending.values()) add(r, r.reservedMicroUsd);
  return [...sums].map(([key, s]) => ({ key, spentMicroUsd: s.spent, ttlMs: s.expiresAt - nowMs }));

  function add(r: Pick<ReservedRecord, 'ts' | 'tenant' | 'team' | 'keyId' | 'billing' | 'attribution'>, cost: number | null): void {
    if (cost === null || !(cost > 0)) return;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) return;
    for (const b of policy.budgets) {
      const value = levelValue(b.scope, r, budgetEnforced(b, r.billing));
      if (value === null) continue;
      let start: string | null = null;
      let resetsAt: string | null = null;
      if (b.window !== null) {
        const now = current.get(b.window);
        if (now === undefined || windowOf(b.window, ts).start !== now.start) continue;
        start = now.start;
        resetsAt = now.end;
      }
      const key = budgetKey(r.tenant, b.name, value, start);
      const sum = sums.get(key);
      if (sum) sum.spent += Math.round(cost);
      else sums.set(key, { spent: Math.round(cost), expiresAt: budgetExpiresAt(resetsAt, nowMs) });
    }
  }
}
