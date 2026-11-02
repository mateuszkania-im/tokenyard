// Live-test harness (spec 14.1, R12): the gateway with the live policy, the memory store and a cap that tokenyard
// itself enforces across runs. The provider key is read only from `env` inside this process, by the gateway; the
// harness prints the gateway URL, a `ty_` client key made for this run and the remaining budget, nothing else.
import { randomBytes } from 'node:crypto';
import { access, constants, mkdir, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createKey } from '../edge/keys.js';
import { createGatewayRuntime } from '../edge/handler.js';
import { createGateway, DEFAULT_BODY_CAP_BYTES } from '../edge/server.js';
import { ulid } from '../edge/ulid.js';
import { loadTraceRecords } from '../ledger/export.js';
import type { LedgerLine } from '../ledger/record.js';
import { defaultInstanceId, TraceWriter } from '../ledger/writer.js';
import { createMemoryStore } from '../limits/memory-store.js';
import { RESERVATION_DEADLINE_MS, SWEEP_INTERVAL_MS } from '../limits/open-store.js';
import { startSweeper } from '../limits/sweeper.js';
import { warmupEntries } from '../limits/warmup.js';
import { compilePolicy } from '../policy/compile.js';
import { parsePolicyFiles } from '../policy/load-dir.js';
import type { CompiledPolicy } from '../policy/types.js';

/** The live credits expire after this day (R12); the harness refuses to start later. */
export const LIVE_LAST_DAY = '2026-11-16';
/** The hard cap on all live runs together, in USD (spec 14.1). */
export const LIVE_MAX_USD = 20;
/** The live policy's one budget; the harness sets its `usd` from TOKENYARD_LIVE_BUDGET_USD. */
export const LIVE_BUDGET = 'live-total';
const LIVE_TENANT = 'live';
/** Where `npm run live` (run from the repo root) finds the live policy. */
const LIVE_POLICY_DIR = join('test', 'live');
/** Warm-up reads a month window, plus a day for a month that just started. */
const WARMUP_LOOKBACK_MS = 32 * 86_400_000;

/** Whether a live run may start. Checks presence of the keys only; no reason ever carries a value. */
export function liveGuard(env: NodeJS.ProcessEnv, today: string): { ok: true; capUsd: number; codexLive: boolean } | { ok: false; reason: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || today > LIVE_LAST_DAY) return { ok: false, reason: `live tests end on ${LIVE_LAST_DAY} (the credits expire); today is ${today}` };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: 'ANTHROPIC_API_KEY is not set (npm run live reads it from .env)' };
  const raw = env.TOKENYARD_LIVE_BUDGET_USD;
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: `TOKENYARD_LIVE_BUDGET_USD is not set (at most ${LIVE_MAX_USD})` };
  const capUsd = Number(raw);
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > LIVE_MAX_USD) return { ok: false, reason: `TOKENYARD_LIVE_BUDGET_USD must be a number above 0 and at most ${LIVE_MAX_USD}` };
  return { ok: true, capUsd, codexLive: Boolean(env.OPENAI_API_KEY) };
}

/**
 * test/live/policy.yaml compiled with `live-total` set to `capUsd` and one key (tenant live) whose hash is `keyHash`.
 * `upstream` points the Anthropic provider elsewhere (tests: the mock).
 */
export function loadLivePolicy(o: { capUsd: number; keyHash: string; dir?: string; upstream?: string }): CompiledPolicy {
  const dir = o.dir ?? LIVE_POLICY_DIR;
  const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
  const keys = `- ${JSON.stringify({ hash: o.keyHash, keyId: `key_${o.keyHash.slice(0, 8)}`, tenant: LIVE_TENANT, team: LIVE_TENANT, name: 'live', kind: 'developer', billing: 'api' })}\n`;
  const src = parsePolicyFiles(dir, { 'policy.yaml': read('policy.yaml'), 'prices.yaml': read('prices.yaml'), 'keys.yaml': keys });
  const budgets = src.policy.budgets;
  const total = budgets[0];
  if (budgets.length !== 1 || total?.name !== LIVE_BUDGET || total.scope !== 'tenant' || total.window !== 'month') {
    throw new Error(`the live policy must have exactly one budget, ${LIVE_BUDGET} (scope tenant, window month)`);
  }
  total.usd = o.capUsd;
  total.onExceed = 'block';
  total.mode = 'enforce';
  if (o.upstream !== undefined) {
    const p = src.policy.providers.anthropic;
    if (!p) throw new Error('the live policy has no provider anthropic');
    p.baseUrl = o.upstream;
  }
  return compilePolicy(src, 'live', { experimentalSubscription: false });
}

/** Every directory and file under `dir` must be readable: a cap seeded from part of the traces would be too high. */
async function assertReadable(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await assertReadable(p);
    else await access(p, constants.R_OK);
  }
}

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

export async function startLiveHarness(o: {
  env: NodeJS.ProcessEnv;
  today: string;
  /** `.live/traces` for real runs (gitignored); tests give a temporary directory. */
  traceDir: string;
  port: number;
  /** Tests only: the mock in place of api.anthropic.com. */
  upstream?: string;
  policyDir?: string;
}): Promise<{ url: string; clientKey: string; spentMicroUsd: number; close(): Promise<void> }> {
  const guard = liveGuard(o.env, o.today);
  if (!guard.ok) throw new Error(`tokenyard live: ${guard.reason}`);
  const { plaintext: clientKey, hash } = createKey();
  const policy = loadLivePolicy({ capUsd: guard.capUsd, keyHash: hash, ...(o.policyDir ? { dir: o.policyDir } : {}), ...(o.upstream ? { upstream: o.upstream } : {}) });

  // Seed the cap from every earlier live trace (warm-up, spec 9.2 step 6); refuse when any of them cannot be read.
  const now = Date.now();
  let spentMicroUsd: number;
  const store = createMemoryStore({ clock: Date.now, deadlineMs: RESERVATION_DEADLINE_MS, onSwept: (ids) => runtime.onSwept(ids) });
  const runtime = createGatewayRuntime();
  try {
    await mkdir(o.traceDir, { recursive: true });
    await assertReadable(o.traceDir);
    const records = await loadTraceRecords({ path: o.traceDir, sinceMs: now - WARMUP_LOOKBACK_MS, untilMs: now });
    const entries = await warmupEntries(
      (async function* (): AsyncIterable<LedgerLine> {
        yield* records;
      })(),
      policy,
      now,
    );
    await store.seed(entries);
    spentMicroUsd = entries.reduce((n, e) => n + e.spentMicroUsd, 0);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`tokenyard live: cannot read the live trace dir ${o.traceDir}${code ? ` (${code})` : ''}; refusing to start without the earlier spend`);
  }

  const writer = new TraceWriter({ dir: o.traceDir, instanceId: defaultInstanceId(hostname(), now), queueMax: 10_000, clock: Date.now });
  let ticks = 0;
  const stopSweeper = startSweeper(store, {
    intervalMs: SWEEP_INTERVAL_MS,
    onTick: () => {
      if (++ticks % 2 === 0) writer.heartbeat();
    },
    onError: (e) => console.error(`tokenyard live: sweeper: ${e instanceof Error ? e.message : String(e)}`),
  });
  const gw = createGateway({
    policy: () => policy,
    store,
    runtime,
    traces: writer,
    traceSalt: o.env.TOKENYARD_TRACE_SALT || randomBytes(16).toString('hex'),
    clock: Date.now,
    newId: () => ulid(),
    basePath: null,
    bodyCapBytes: DEFAULT_BODY_CAP_BYTES,
    env: o.env,
  });
  let url: string;
  try {
    url = await gw.listen(o.port, '127.0.0.1');
  } catch (e) {
    stopSweeper();
    await writer.close();
    throw e;
  }
  const capMicro = Math.round(guard.capUsd * 1_000_000);
  process.stdout.write(
    [
      `tokenyard live: gateway ${url}`,
      `tokenyard live: client key ${clientKey}`,
      `tokenyard live: ${LIVE_BUDGET} ${usd(capMicro)}, spent ${usd(spentMicroUsd)}, remaining ${usd(Math.max(0, capMicro - spentMicroUsd))}`,
      `tokenyard live: codex ${guard.codexLive ? 'live' : 'not live (no OPENAI_API_KEY)'}`,
      '',
    ].join('\n'),
  );
  return {
    url,
    clientKey,
    spentMicroUsd,
    async close() {
      stopSweeper();
      await gw.close();
      await writer.close();
    },
  };
}
