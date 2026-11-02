// Warm-up (spec 9.2 step 6, 14.1): the spend recorded in traces, summed per budget key, for the budget windows that
// contain `nowMs`, so a restarted gateway (or the live harness) starts from what was already spent. Keys and scope
// values are derived exactly as `decide` derives them, "(unattributed)" for a missing header included.
import type { LedgerLine } from '../ledger/record.js';
import { budgetEnforced, levelValue, windowOf } from '../policy/decide.js';
import type { CompiledPolicy } from '../policy/types.js';
import { budgetKey } from './keys.js';
import { budgetExpiresAt } from './store.js';

export async function warmupEntries(records: AsyncIterable<LedgerLine>, policy: CompiledPolicy, nowMs: number): Promise<Array<{ key: string; spentMicroUsd: number; ttlMs: number }>> {
  const current = new Map(policy.budgets.flatMap((b) => (b.window === null ? [] : [[b.window, windowOf(b.window, nowMs)] as const])));
  const sums = new Map<string, { spent: number; expiresAt: number }>();
  for await (const r of records) {
    if (r.kind !== 'request') continue;
    // What the store charged (the estimate when the sweeper settled); older traces and requests without a reservation have only the cost.
    const cost = r.outcome.chargedMicroUsd ?? r.outcome.costMicroUsd;
    if (cost === null || !(cost > 0)) continue;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) continue;
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
  return [...sums].map(([key, s]) => ({ key, spentMicroUsd: s.spent, ttlMs: s.expiresAt - nowMs }));
}
