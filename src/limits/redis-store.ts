// Redis counter store (spec 7.2): admit, settle, sweep and seed are Lua scripts, so each is atomic. `admit` is one
// round trip (EVALSHA; EVAL once after a NOSCRIPT). GCRA runs on Redis TIME, not the instance clock.
import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { Admission } from '../policy/types.js';
import { deadlinesKey, reservationKey, sweepLockKey, tenantOfKey } from './keys.js';
import { ADMIT_LUA, SEED_LUA, SETTLE_LUA, SWEEP_LUA } from './lua.js';
import { assertMicroUsd, budgetExpiresAt, type CounterStore, planTenant, SESSION_BUDGET_TTL_MS } from './store.js';

/** The one client method the store uses; any node-redis client (single node, RESP 2 or 3) has it. */
type Client = Pick<RedisClientType, 'sendCommand'>;

interface Script {
  source: string;
  sha: string;
}
const script = (source: string): Script => ({ source, sha: createHash('sha1').update(source).digest('hex') });
const ADMIT = script(ADMIT_LUA);
const SETTLE = script(SETTLE_LUA);
const SWEEP = script(SWEEP_LUA);
const SEED = script(SEED_LUA);
const SWEEP_BATCH = 500;
/** `ty:{tenant}:deadlines` exactly: the encoded tenant holds no `{`, `}` or `:`. */
const DEADLINES = /^ty:\{[^{}:]*\}:deadlines$/;

const NOTHING: Admission = { admitted: true, failed: null, audit: [], totals: [] };
const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []); // cjson encodes an empty array as {}

interface AdmitReply {
  r: 'ok' | 'dup' | 'taint' | 'rate' | 'streams' | 'budget';
  name?: string;
  rule?: string;
  /** Taint: the history HMAC found in the set. */
  h?: string;
  retry?: string;
  spent?: string;
  audit?: Array<[string, boolean]> | Record<string, never>;
  totals?: Array<[string, string, string, string]> | Record<string, never>;
}

/**
 * `onSwept` receives the ids of the reservations a sweep settled (they get `settledBy: sweeper`), whichever instance
 * admitted them. `sweep(nowMs)` ignores `nowMs`: overdue is judged on Redis TIME, the clock admit used.
 */
export function createRedisStore(client: Client, o: { deadlineMs: number; onSwept?: (ids: string[]) => void }): CounterStore {
  /** Open reservations admitted by this instance: id to tenant, so settle can name the record. */
  const open = new Map<string, string>();
  let loaded: Promise<void> | null = null;

  const load = (): Promise<void> =>
    (loaded ??= Promise.all([ADMIT, SETTLE, SWEEP, SEED].map((s) => client.sendCommand(['SCRIPT', 'LOAD', s.source]))).then(
      () => undefined,
      (e: unknown) => {
        loaded = null;
        throw e;
      },
    ));

  async function run(s: Script, keys: string[], args: string[]): Promise<unknown> {
    await load();
    const tail = [String(keys.length), ...keys, ...args];
    try {
      return await client.sendCommand(['EVALSHA', s.sha, ...tail]);
    } catch (e) {
      // The script cache was flushed (restart, SCRIPT FLUSH, failover): EVAL runs it and caches it again.
      if (!(e instanceof Error && e.message.startsWith('NOSCRIPT'))) throw e;
      return client.sendCommand(['EVAL', s.source, ...tail]);
    }
  }

  return {
    async admit(plan) {
      const tenant = planTenant(plan);
      if (tenant === null) return NOTHING;
      const now = Date.now();
      const keys = [
        reservationKey(tenant, plan.id),
        deadlinesKey(tenant),
        ...plan.reservations.map((l) => l.key),
        ...plan.rateChecks.map((c) => c.key),
        ...plan.streamSlots.map((s) => s.key),
        ...(plan.taint ? [plan.taint.key] : []),
      ];
      const arg = {
        dl: o.deadlineMs,
        sttl: 2 * o.deadlineMs,
        sx: SESSION_BUDGET_TTL_MS,
        b: plan.reservations.map((l) => ({ n: l.budget, e: l.estMicroUsd, l: l.limitMicroUsd, f: l.enforce, x: l.resetsAt === null ? -1 : budgetExpiresAt(l.resetsAt, now) })),
        g: plan.rateChecks.map((c) => ({ n: c.limit, e: c.emissionMs, b: c.burst, q: c.quantity })),
        s: plan.streamSlots.map((s) => ({ n: s.limit, m: s.max })),
        ...(plan.taint ? { t: { c: plan.taint.check, a: plan.taint.add.map((a) => [a.valueHmac, a.rule]), ttl: plan.taint.ttlMs } } : {}),
      };
      const reply = JSON.parse(String(await run(ADMIT, keys, [JSON.stringify(arg)]))) as AdmitReply;
      const audit = list<[string, boolean]>(reply.audit).map(([name, wouldFail]) => ({ name, wouldFail }));
      const totals = list<[string, string, string, string]>(reply.totals).map(([key, s, r, l]) => ({ key, spentMicroUsd: Number(s), reservedMicroUsd: Number(r), limitMicroUsd: Number(l) }));
      const name = reply.name ?? '';
      switch (reply.r) {
        case 'ok':
          open.set(plan.id, tenant);
          return { admitted: true, failed: null, audit, totals };
        case 'dup':
          return NOTHING;
        case 'taint':
          return { admitted: false, failed: { kind: 'taint', name: 'taint', rule: reply.rule ?? '', ...(reply.h ? { valueHmac: reply.h } : {}) }, audit: [], totals: [] };
        case 'rate':
          return { admitted: false, failed: { kind: 'rate', name, retryAfterMs: Number(reply.retry) }, audit: [], totals: [] };
        case 'streams':
          return { admitted: false, failed: { kind: 'streams', name }, audit: [], totals: [] };
        case 'budget':
          return { admitted: false, failed: { kind: 'budget', name, spentMicroUsd: Number(reply.spent) }, audit, totals };
      }
    },

    // Settled by the instance that admitted the request: the id's tenant is known here only. A reservation whose
    // instance died is settled by the sweeper. `perLevel` is accepted for the spec 7.1 signature and not used.
    async settle(id, actualMicroUsd) {
      assertMicroUsd(actualMicroUsd, 'actual cost');
      const tenant = open.get(id);
      if (tenant === undefined) return 'unknown';
      const done = await run(SETTLE, [reservationKey(tenant, id), deadlinesKey(tenant)], [String(actualMicroUsd)]);
      open.delete(id);
      return Number(done) === 1 ? 'settled' : 'unknown';
    },

    async sweep() {
      let n = 0;
      let cursor = '0';
      do {
        const [next, found] = (await client.sendCommand(['SCAN', cursor, 'MATCH', 'ty:{*}:deadlines', 'COUNT', '1000'])) as [unknown, unknown[]];
        cursor = String(next);
        for (const key of found.map(String).filter((k) => DEADLINES.test(k))) {
          for (;;) {
            const done = list<unknown>(await run(SWEEP, [key], [String(SWEEP_BATCH)])).map(String);
            n += done.length;
            // `ty:{t}:res:<encoded id>`: the encoded id holds no ':'.
            const ids = done.map((resKey) => decodeURIComponent(resKey.slice(resKey.lastIndexOf(':') + 1)));
            for (const id of ids) open.delete(id);
            if (ids.length > 0) o.onSwept?.(ids);
            if (done.length < SWEEP_BATCH) break;
          }
        }
      } while (cursor !== '0');
      return n;
    },

    async snapshot(keys) {
      const rows = await Promise.all(keys.map((k) => client.sendCommand(['HMGET', k, 's', 'r']) as Promise<Array<unknown>>));
      return Object.fromEntries(keys.map((k, i) => {
        const [s, r] = rows[i] ?? [];
        return [k, { spent: Number(s ?? 0), reserved: Number(r ?? 0) }];
      }));
    },

    async seed(entries) {
      for (const e of entries) {
        if (tenantOfKey(e.key) === null) throw new Error(`counter key without a tenant tag: ${e.key}`);
        assertMicroUsd(e.spentMicroUsd, 'seeded spend');
      }
      await Promise.all(entries.filter((e) => e.ttlMs > 0).map((e) => run(SEED, [e.key], [String(e.spentMicroUsd), String(Math.ceil(e.ttlMs))])));
    },
  };
}

/** Sweeper lock (spec 7.2): `SET ty:{tenant}:sweep-lock <instance> NX PX 25000`, so one instance sweeps per interval. */
export function redisSweepLock(client: Client, o: { tenant: string; instance: string; ttlMs?: number }): { acquire(): Promise<boolean> } {
  const key = sweepLockKey(o.tenant);
  return {
    acquire: async () => String(await client.sendCommand(['SET', key, o.instance, 'NX', 'PX', String(o.ttlMs ?? 25_000)])) === 'OK',
  };
}
