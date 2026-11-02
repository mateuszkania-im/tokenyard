// What `serve` needs from the counter store at start: the store itself (memory or Redis), the sweeper lock for Redis,
// and the warm-up that seeds spend recorded in the trace dir (spec 9.2 step 6, 14.1).
import { existsSync } from 'node:fs';
import type { LedgerLine } from '../ledger/record.js';
import { loadTraceRecords } from '../ledger/export.js';
import type { CompiledPolicy } from '../policy/types.js';
import { SWEEP_LOCK_TENANT } from './keys.js';
import { createMemoryStore } from './memory-store.js';
import type { CounterStore } from './store.js';
import { warmupEntries } from './warmup.js';

/** Reservation deadline: 2 times a 10 minute request timeout (spec 7.2). */
export const RESERVATION_DEADLINE_MS = 20 * 60_000;
/** Sweeper interval (spec 7.2: every 30 s). */
export const SWEEP_INTERVAL_MS = 30_000;
/** How far back warm-up reads traces: the longest window (a month) and the session TTL (30 days), plus a day. */
const WARMUP_LOOKBACK_MS = 32 * 86_400_000;

export interface OpenedStore {
  store: CounterStore;
  /** Redis only: one instance sweeps per interval (`SET NX PX` on `ty:{_sweeper}:sweep-lock`). */
  lock?: { acquire(): Promise<boolean> };
  close(): Promise<void>;
}

export async function openCounterStore(o: { kind: 'memory' | 'redis'; redisUrl?: string; instance: string; onSwept: (ids: string[]) => void }): Promise<OpenedStore> {
  if (o.kind === 'memory') return { store: createMemoryStore({ clock: Date.now, deadlineMs: RESERVATION_DEADLINE_MS, onSwept: o.onSwept }), close: async () => undefined };
  if (!o.redisUrl) throw new Error('--store redis needs --redis-url');
  const { createClient } = await import('redis');
  const { createRedisStore, redisSweepLock } = await import('./redis-store.js');
  const client = createClient({ url: o.redisUrl });
  // node-redis reconnects on its own; an error event without a listener would crash the process.
  client.on('error', () => undefined);
  await client.connect();
  return {
    store: createRedisStore(client, { deadlineMs: RESERVATION_DEADLINE_MS, onSwept: o.onSwept }),
    lock: redisSweepLock(client, { tenant: SWEEP_LOCK_TENANT, instance: o.instance }),
    close: async () => void (await client.close()),
  };
}

/** Seeds the store with the spend the trace dir records for the current windows; returns how many keys were seeded. */
export async function warmUpFromTraces(store: CounterStore, traceDir: string, policy: CompiledPolicy, nowMs: number): Promise<number> {
  if (!existsSync(traceDir)) return 0;
  const records = await loadTraceRecords({ path: traceDir, sinceMs: nowMs - WARMUP_LOOKBACK_MS, untilMs: nowMs });
  async function* lines(): AsyncIterable<LedgerLine> {
    yield* records;
  }
  const entries = await warmupEntries(lines(), policy, nowMs);
  await store.seed(entries);
  return entries.length;
}
