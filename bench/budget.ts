// Spec 12.3 item 2: budget correctness. The G4 scenario of spec 7.4 (1,000 requests sent at once through the gateway
// against a $1 budget, actual cost drawn between 0 and each request's limits) on each store and estimator, and the
// in-flight headroom of the 150,000-byte example turn under a $25 session budget (the README's concurrency trade-off).
import { Agent } from 'node:http';
import type { TraceRecord } from '../src/ledger/record.js';
import { createMemoryStore } from '../src/limits/memory-store.js';
import type { CounterStore } from '../src/limits/store.js';
import { startAnthropicMock } from '../src/mock/anthropic.js';
import { authHeaders, send } from '../test/helpers/conformance.js';
import { startGateway } from '../test/helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../test/helpers/policy.js';
import { spyStore } from '../test/helpers/store-spy.js';
import { BENCH_PROVIDER_KEY, preconnect } from './lib.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
type Estimator = 'worst-case' | 'session-aware';
const LIMIT_MICRO = 1_000_000;
const N = 1_000;

export interface BudgetRun {
  store: 'memory' | 'redis';
  estimator: Estimator;
  limitUsd: number;
  requests: number;
  /** Admit calls made before the first settle call: requests decided while the first admitted ones were still open. */
  admitsBeforeFirstSettle: number;
  /** Most admitted, unsettled reservations at once. */
  maxOpenReservations: number;
  admitted: number;
  rejected: number;
  finalSpentUsd: number;
  maxSpentPlusReservedUsd: number;
  /** How far final spend, or spend plus reservations after any admit, went above the limit (0 when never). */
  maxOverspendUsd: number;
  /** Final spend minus the sum of the costs settled (micro-USD); not 0 means a lost update. */
  spendDriftMicroUsd: number;
  /** Reservations left on the counter after every request settled (micro-USD). */
  reservedLeftMicroUsd: number;
  overruns: number;
}

export interface Headroom {
  bodyBytes: number;
  maxTokens: number;
  model: string;
  sessionBudgetUsd: number;
  rows: Array<{ estimator: Estimator; reservationUsd: number; inFlightAdmitted: number; sent: number }>;
}

/** The G4 bodies (test/limits/budget-proof.test.ts): sizes and max_tokens vary, so reservations differ. */
function g4Body(i: number): Buffer {
  const text = 'x'.repeat(100 + ((i * 7919) % 3_900));
  return Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16 + ((i * 104_729) % 2_000), stream: i % 2 === 0, messages: [{ role: 'user', content: text }] }));
}

const closeAll = async (cs: Array<() => Promise<void>>): Promise<void> => {
  for (const c of cs.reverse()) await c();
};

export async function g4Run(store: 'memory' | 'redis', inner: CounterStore, estimator: Estimator): Promise<BudgetRun> {
  process.env[PROVIDER_KEY_ENV] = BENCH_PROVIDER_KEY;
  const closers: Array<() => Promise<void>> = [];
  try {
    const mock = await startAnthropicMock({ scenario: { kind: 'randomUsage', seed: 42 } });
    closers.push(mock.close);
    // How concurrent the run really was: admit calls made before the first settle (all of them decided while the first
    // admitted requests were still open), and the most admitted, unsettled reservations at once.
    let admits = 0;
    let admitsBeforeFirstSettle: number | null = null;
    let open = 0;
    let maxOpenReservations = 0;
    const counted: CounterStore = {
      admit: async (plan, nowMs) => {
        admits++;
        const a = await inner.admit(plan, nowMs);
        if (a.admitted) maxOpenReservations = Math.max(maxOpenReservations, ++open);
        return a;
      },
      settle: async (id, actual, perLevel) => {
        admitsBeforeFirstSettle ??= admits;
        const r = await inner.settle(id, actual, perLevel);
        open--;
        return r;
      },
      sweep: (n) => inner.sweep(n),
      snapshot: (k) => inner.snapshot(k),
      seed: (e) => inner.seed(e),
    };
    const spy = spyStore(counted);
    const traces: Rec[] = [];
    const policy = testPolicy({
      upstream: mock.url,
      edit: (p) => {
        p.budgets = [{ name: 'proof', scope: 'tenant', window: 'day', usd: 1, onExceed: 'block', mode: 'enforce' }];
        p.rateLimits = [];
        p.reservation.estimator = estimator;
      },
    });
    const gw = await startGateway({ policy, store: spy.store, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's' });
    closers.push(gw.close);
    // One open connection per request, opened beforehand, so all 1,000 requests are sent at the same moment.
    const agents = Array.from({ length: N }, () => new Agent({ keepAlive: true, maxSockets: 1 }));
    closers.push(async () => agents.forEach((a) => a.destroy()));
    await preconnect(agents, gw.url);
    await Promise.all(agents.map((agent, i) => send(gw.url, { path: '/v1/messages', headers: authHeaders, body: g4Body(i), agent })));
    for (let i = 0; i < 400 && (traces.length < N || spy.settles.length < spy.admits.filter((a) => a.admission.admitted).length); i++) await new Promise((r) => setTimeout(r, 50));
    const admitted = spy.admits.filter((a) => a.admission.admitted);
    const key = spy.admits[0]?.plan.reservations[0]?.key as string;
    const final = (await inner.snapshot([key]))[key] ?? { spent: 0, reserved: 0 };
    const settled = spy.settles.filter((s) => s.result === 'settled').reduce((n, s) => n + s.actual, 0);
    const maxSR = Math.max(0, ...admitted.flatMap((a) => a.admission.totals.map((t) => t.spentMicroUsd + t.reservedMicroUsd)));
    return {
      store,
      estimator,
      limitUsd: LIMIT_MICRO / 1e6,
      requests: N,
      admitsBeforeFirstSettle: admitsBeforeFirstSettle ?? admits,
      maxOpenReservations,
      admitted: admitted.length,
      rejected: spy.admits.length - admitted.length,
      finalSpentUsd: final.spent / 1e6,
      maxSpentPlusReservedUsd: maxSR / 1e6,
      maxOverspendUsd: Math.max(0, final.spent - LIMIT_MICRO, maxSR - LIMIT_MICRO) / 1e6,
      spendDriftMicroUsd: final.spent - settled,
      reservedLeftMicroUsd: final.reserved,
      overruns: traces.filter((t) => t.outcome.overrun).length,
    };
  } finally {
    await closeAll(closers);
  }
}

/** A Claude Code shaped turn of exactly `bytes` bytes: block system with a cache marker, tool results, max_tokens 32,000. */
export function turnBody(bytes: number): Buffer {
  const block = { type: 'tool_result', tool_use_id: 'toolu_1', content: '' };
  const base = {
    model: 'claude-opus-5-5',
    max_tokens: 32000,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [block] }],
  };
  block.content = 'a'.repeat(bytes - Buffer.byteLength(JSON.stringify(base)));
  const out = Buffer.from(JSON.stringify(base));
  if (out.length !== bytes) throw new Error(`turn body is ${out.length} bytes, not ${bytes}`);
  return out;
}

/** Sends `sent` concurrent turns in one session while the mock holds every stream open; counts the 200s. */
async function headroomRun(estimator: Estimator, sent: number): Promise<{ reservationUsd: number; inFlightAdmitted: number }> {
  process.env[PROVIDER_KEY_ENV] = BENCH_PROVIDER_KEY;
  const closers: Array<() => Promise<void>> = [];
  try {
    const mock = await startAnthropicMock({ scenario: { kind: 'ok', ttftMs: 3_000, tokensPerSec: 0, pingEveryMs: null, outputTokens: 50 } });
    closers.push(mock.close);
    const traces: Rec[] = [];
    const policy = testPolicy({
      upstream: mock.url,
      edit: (p) => {
        p.budgets = [{ name: 'session', scope: 'session', usd: 25, onExceed: 'block', mode: 'enforce' }];
        p.rateLimits = [];
        p.reservation.estimator = estimator;
      },
    });
    const gw = await startGateway({ policy, store: createMemoryStore({ clock: Date.now }), traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's' });
    closers.push(gw.close);
    const agent = new Agent({ keepAlive: true, maxSockets: sent });
    closers.push(async () => agent.destroy());
    const headers = { ...authHeaders, 'x-claude-code-session-id': 'bench-session-1', 'user-agent': 'claude-cli/2.1.316 (external, cli)' };
    const body = turnBody(150_000);
    const res = await Promise.all(Array.from({ length: sent }, () => send(gw.url, { path: '/v1/messages', headers, body, agent })));
    const reserved = traces.map((t) => t.decision.reservedMicroUsd).filter((r) => r > 0);
    return { reservationUsd: Math.max(0, ...reserved) / 1e6, inFlightAdmitted: res.filter((r) => r.status === 200).length };
  } finally {
    await closeAll(closers);
  }
}

export async function benchBudget(o: { redis: (() => Promise<CounterStore>) | null; log: (s: string) => void }): Promise<{ runs: BudgetRun[]; headroom: Headroom }> {
  const runs: BudgetRun[] = [];
  for (const estimator of ['worst-case', 'session-aware'] as const) {
    runs.push(await g4Run('memory', createMemoryStore({ clock: Date.now }), estimator));
    if (o.redis) runs.push(await g4Run('redis', await o.redis(), estimator));
  }
  for (const r of runs) o.log(`budget ${r.store} ${r.estimator}: admitted ${r.admitted}, final $${r.finalSpentUsd}, max overspend $${r.maxOverspendUsd}`);
  const sent = 40;
  const rows: Headroom['rows'] = [];
  for (const estimator of ['worst-case', 'session-aware'] as const) rows.push({ estimator, sent, ...(await headroomRun(estimator, sent)) });
  for (const r of rows) o.log(`headroom ${r.estimator}: reservation $${r.reservationUsd}, ${r.inFlightAdmitted} of ${sent} admitted in flight`);
  return { runs, headroom: { bodyBytes: 150_000, maxTokens: 32_000, model: 'claude-opus-5-5', sessionBudgetUsd: 25, rows } };
}
