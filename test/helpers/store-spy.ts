import type { CounterStore } from '../../src/limits/store.js';
import type { Admission, Plan } from '../../src/policy/types.js';

export interface StoreSpy {
  store: CounterStore;
  admits: Array<{ plan: Plan; admission: Admission }>;
  settles: Array<{ id: string; actual: number; result: 'settled' | 'unknown' }>;
}

/** Wraps a store and records every admit (with its plan and answer) and every settle, in commit order. */
export function spyStore(inner: CounterStore): StoreSpy {
  const admits: StoreSpy['admits'] = [];
  const settles: StoreSpy['settles'] = [];
  const store: CounterStore = {
    async admit(plan, nowMs) {
      const admission = await inner.admit(plan, nowMs);
      admits.push({ plan: structuredClone(plan), admission });
      return admission;
    },
    async settle(id, actual, perLevel) {
      const result = await inner.settle(id, actual, perLevel);
      settles.push({ id, actual, result });
      return result;
    },
    sweep: (nowMs) => inner.sweep(nowMs),
    snapshot: (keys) => inner.snapshot(keys),
    seed: (entries) => inner.seed(entries),
  };
  return { store, admits, settles };
}
