// Spec 7.1 counter store interface (type only). Task 13 adds the memory and Redis implementations.
import type { Admission, Plan } from '../policy/types.js';

export interface CounterStore {
  admit(plan: Plan, nowMs?: number): Promise<Admission>;          // atomic: rate checks, stream slots, taint, all reservations
  settle(id: string, actualMicroUsd: number, perLevel?: boolean): Promise<'settled' | 'unknown'>;  // idempotent; releases the stream slot
  sweep(nowMs: number): Promise<number>;                            // settles overdue reservations and frees their slots
  snapshot(keys: string[]): Promise<Record<string, { spent: number; reserved: number }>>;
  seed(entries: Array<{ key: string; spentMicroUsd: number; ttlMs: number }>): Promise<void>;  // warm-up from traces (9.2, 14.1)
}
