// Spec 9.2 and 9.3: replay over a merged trace set, base and head each on their own simulated counter store.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { LedgerLine, ManifestRecord, TraceRecord } from '../../src/ledger/record.js';
import { openReplayTraces } from '../../src/policy-loader/replay-input.js';
import { compilePolicy } from '../../src/policy/compile.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import { EXACTNESS_TABLE } from '../../src/replay/diff.js';
import { RawTraceDirError, replay, type ReplayResult } from '../../src/replay/engine.js';
import { renderJson } from '../../src/replay/render-json.js';
import { renderTerminal } from '../../src/replay/render-terminal.js';
import { baseRecord } from '../helpers/trace.js';
import { HEAD, source } from '../policy/helpers.js';
import { readFileSync } from 'node:fs';

const T0 = Date.UTC(2026, 10, 2, 10, 0);
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const PRICES = '2026-11-03';

/** Example prices, one route `all` to provider a unless `routes` replaces it; budgets and ci as given. */
function policy(o: { revision?: string; routes?: string; budgets?: string; ci?: string } = {}): CompiledPolicy {
  const yaml = `${HEAD}routes:
${o.routes ?? '  - { name: all, chain: [a] }'}
${o.budgets ? `budgets:\n${o.budgets}\n` : ''}failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
${o.ci ?? ''}`;
  return compilePolicy(source(yaml), o.revision ?? 'rev1', { experimentalSubscription: false });
}

type Usage = NonNullable<TraceRecord['outcome']['usage']>;
interface RecOver {
  id: string;
  min: number;
  session?: string | null;
  team?: string | null;
  repo?: string | null;
  requestClass?: string | null;
  model?: string;
  usage?: Usage | null;
  cost?: number | null;
  decision?: Partial<TraceRecord['decision']>;
  hits?: TraceRecord['guardrail']['hits'];
  revision?: string;
  instance?: string;
  seq?: number;
}

/** A request recorded under `rev1` through route `all` (provider a); cost and charge default to 1,000 micro-USD. */
function rec(o: RecOver): TraceRecord {
  const b = baseRecord({ id: o.id, ts: iso(T0 + o.min * MIN) });
  const model = o.model ?? 'claude-opus-5-5';
  const cost = o.cost === undefined ? 1000 : o.cost;
  const forward = (o.decision?.action ?? 'forward') === 'forward';
  return {
    ...b,
    team: o.team === undefined ? 'web' : o.team,
    instance: o.instance ?? 'i1',
    seq: o.seq ?? 1,
    attribution: { ...b.attribution, session: o.session === undefined ? 'sess' : o.session, repo: o.repo === undefined ? 'shop' : o.repo, requestClass: o.requestClass === undefined ? 'main' : o.requestClass },
    features: { ...b.features, model },
    guardrail: { hits: o.hits ?? [] },
    policy: { revision: o.revision ?? 'rev1' },
    decision: { ...b.decision, route: 'all', chain: ['a'], ...o.decision },
    outcome: {
      ...b.outcome,
      provider: forward ? 'a' : null,
      upstreamModel: forward ? model : null,
      usage: forward ? (o.usage === undefined ? b.outcome.usage : o.usage) : null,
      costMicroUsd: forward ? cost : null,
      ...(forward && cost !== null ? { chargedMicroUsd: cost } : {}),
      priceTable: PRICES,
    },
  };
}

async function* lines(xs: LedgerLine[]): AsyncIterable<LedgerLine> {
  yield* xs;
}

const run = (base: CompiledPolicy, head: CompiledPolicy, xs: LedgerLine[], o: { sinceMs?: number | null; tenant?: string | null } = {}): Promise<ReplayResult> =>
  replay({ base, head, traces: lines(xs), sinceMs: o.sinceMs ?? null, tenant: o.tenant ?? null });

const TEAM_DAY = (usd: number): string => `  - { name: team-day, scope: team, window: day, usd: ${usd} }`;
// Each test record reserves (100 input tokens at 8 + 64 output tokens at 20) times 1.1 = 2,288 micro-USD on opus.

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test('tightening team-day blocks the requests that cross it, in ts order', async () => {
  // Out of order on purpose: replay orders by ts, then id. Distinct sessions, so nothing is cut.
  const xs = [4, 0, 3, 1, 2].map((m) => rec({ id: `r${m}`, min: m, session: `s${m}` }));
  const r = await run(policy({ budgets: TEAM_DAY(1) }), policy({ revision: 'rev2', budgets: TEAM_DAY(0.005) }), xs);
  expect(r.fidelity.agreement).toBe(1);
  expect(r.base).toMatchObject({ forwarded: 5, blocked: 0, costMicroUsd: 5000, costBasis: 'billed', estimated: false });
  // Spent 3,000 after three requests: 3,000 + 2,288 > 5,000, so the 4th and the 5th by ts are refused.
  expect(r.head).toMatchObject({ forwarded: 3, blocked: 2, costMicroUsd: 3000 });
  expect(r.blocked).toEqual([{ policy: 'head', reason: 'budget', name: 'team-day', count: 2 }]);
  expect(r.budgetHits).toEqual([{ policy: 'head', budget: 'team-day', scopeValue: 'web', firstHitTs: iso(T0 + 3 * MIN), days: 1 }]);
  expect(r.cutSessions).toEqual([]);
  expect(r.requests).toBe(5);
  expect(r.sessions).toBe(5);
});

test('a block after a forwarded request in the same session counts as a cut; later requests drop with their recorded cost', async () => {
  const xs = [0, 1, 2, 3, 4].map((m) => rec({ id: `r${m}`, min: m, cost: m === 4 ? 700 : 1000 }));
  const r = await run(policy({ budgets: TEAM_DAY(1) }), policy({ revision: 'rev2', budgets: TEAM_DAY(0.005) }), xs);
  expect(r.cutSessions).toEqual([
    { policy: 'head', session: 'sess', team: 'web', repo: 'shop', requestClass: 'main', requestIndex: 4, cause: 'budget team-day', droppedRequests: 1, droppedCostMicroUsd: 700 },
  ]);
  expect(r.head).toMatchObject({ forwarded: 3, blocked: 1, costMicroUsd: 3000 });
  expect(r.blocked).toEqual([{ policy: 'head', reason: 'budget', name: 'team-day', count: 1 }]);
});

test('recorded taint block is reproduced from guardrail hits', async () => {
  const secret = { rule: 'aws-access-key-id', action: 'block' as const, valueHmac: 'h1', where: 'last-turn' as const };
  const history = { ...secret, where: 'history' as const };
  const xs = [
    rec({ id: 'r0', min: 0, hits: [secret], decision: { action: 'block', reason: 'secret' } }),
    rec({ id: 'r1', min: 1, hits: [history], decision: { action: 'block', reason: 'taint' } }),
    // Another session carrying the same value was never tainted.
    rec({ id: 'r2', min: 2, session: 'other', hits: [history] }),
  ];
  const p = policy();
  const r = await run(p, p, xs);
  expect(r.fidelity).toMatchObject({ agreement: 1, disagreements: [] });
  expect(r.blocked).toEqual([
    { policy: 'base', reason: 'secret', name: 'aws-access-key-id', count: 1 },
    { policy: 'base', reason: 'taint', name: 'aws-access-key-id', count: 1 },
    { policy: 'head', reason: 'secret', name: 'aws-access-key-id', count: 1 },
    { policy: 'head', reason: 'taint', name: 'aws-access-key-id', count: 1 },
  ]);
  expect(r.base.forwarded).toBe(1);
});

test('model change: cost estimated with output ratio, cache reads become 5m writes for one request', async () => {
  const u = (input: number, cacheRead: number, output: number): Usage => ({ input, cacheRead, output, cacheWrite5m: 0, cacheWrite1h: 0 });
  const xs = [
    // opus, session s1: 100 * 4 + 4,000 * 0.2 + 100 * 20 = 3,200 and 100 * 4 + 5,000 * 0.2 + 100 * 20 = 3,400
    rec({ id: 'r0', min: 0, session: 's1', usage: u(100, 4000, 100), cost: 3200 }),
    rec({ id: 'r1', min: 1, session: 's1', usage: u(100, 5000, 100), cost: 3400 }),
    // sonnet, observed for the same request class: mean output 50 against opus 100, so the ratio is 0.5
    rec({ id: 'r2', min: 2, session: 's2', model: 'claude-sonnet-5-5', usage: u(100, 0, 50), cost: 700 }),
  ];
  const head = policy({
    revision: 'rev2',
    routes: `  - { name: to-sonnet, match: { model: "claude-opus-*" }, chain: [a], rewriteModel: claude-sonnet-5-5, allowBodyRewrite: true, because: test }
  - { name: all, chain: [a] }`,
  });
  const r = await run(policy(), head, xs);
  expect(r.base).toMatchObject({ costMicroUsd: 7300, estimated: false });
  // r0 on sonnet, first switched request of s1: 100 * 2 + 4,000 * 2.5 (5m write) + 50 * 10 = 10,700
  // r1: the recorded hit pattern resumes: 100 * 2 + 5,000 * 0.1 + 50 * 10 = 1,200; r2 unchanged: 700
  expect(r.head).toMatchObject({ costMicroUsd: 12_600, estimated: true });
  expect(r.rerouted).toEqual([{ fromRoute: 'all', toRoute: 'to-sonnet', requestClass: 'main', count: 2 }]);
  const applied = Object.fromEntries(r.exactness.map((e) => [e.output, e.applied]));
  expect(applied['Cost delta when the model changes']).toBe(true);
  expect(applied['Cache effect of a model or provider switch within a session']).toBe(true);
});

test('warm-up seeds budgets from records before --since', async () => {
  const p = policy({ budgets: TEAM_DAY(0.005) });
  const before = [rec({ id: 'p0', min: 0, session: 'a', cost: 1500 }), rec({ id: 'p1', min: 1, session: 'b', cost: 1500 })];
  // 3,000 already spent today: 3,000 + 2,288 > 5,000. Recorded as a budget block, which replay reproduces.
  const inWindow = rec({ id: 'w0', min: 10, session: 'c', decision: { action: 'block', reason: 'budget' } });
  const r = await run(p, p, [...before, inWindow], { sinceMs: T0 + 5 * MIN });
  expect(r.requests).toBe(1);
  expect(r.window).toEqual({ sinceMs: T0 + 5 * MIN, untilMs: T0 + 10 * MIN });
  expect(r.base).toMatchObject({ forwarded: 0, blocked: 1 });
  expect(r.fidelity.agreement).toBe(1);
  // Without the records before the window, the same request would have been forwarded.
  const cold = await run(p, p, [inWindow], { sinceMs: T0 + 5 * MIN });
  expect(cold.base).toMatchObject({ forwarded: 1, blocked: 0 });
  expect(cold.fidelity.agreement).toBe(0);
  expect(cold.fidelity.disagreements).toEqual([{ reason: 'recorded block (budget), replayed forward', count: 1 }]);
});

test('raw per-instance directory is refused with a message naming traces export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ty-replay-'));
  dirs.push(dir);
  await mkdir(join(dir, 'acme', '2026-11-02'), { recursive: true });
  await writeFile(join(dir, 'acme', '2026-11-02', '10.i1.ndjson'), `${JSON.stringify({ v: 1, kind: 'segment', instance: 'i1', startedAt: iso(T0), firstSeq: 1 })}\n`);
  await expect(openReplayTraces([dir])).rejects.toThrow(RawTraceDirError);
  await expect(openReplayTraces([dir])).rejects.toThrow(/tokenyard traces export/);
  // A raw per-instance file passed directly is refused the same way: its segment line gives it away.
  const p = policy();
  await expect(run(p, p, [{ v: 1, kind: 'segment', instance: 'i1', startedAt: iso(T0), firstSeq: 1 }, rec({ id: 'r0', min: 0 })])).rejects.toThrow(/tokenyard traces export/);
});

test('manifest with a missing instance hour and a seq gap is reported under fidelity.missingInstances', async () => {
  const manifest: ManifestRecord = {
    v: 1,
    kind: 'manifest',
    since: iso(T0),
    until: iso(T0 + 3 * 60 * MIN),
    instances: [
      { id: 'i1', firstTs: iso(T0), lastTs: iso(T0 + 3 * 60 * MIN), records: 2, seqGaps: 1, hoursWithoutFile: ['2026-11-02T11'], shutdown: true },
      // No shutdown record, last heartbeat at 11:05 while the window runs to 13:00.
      { id: 'i2', firstTs: iso(T0), lastTs: iso(T0 + 65 * MIN), records: 0, seqGaps: 0, hoursWithoutFile: [], shutdown: false },
    ],
  };
  const xs = [manifest, rec({ id: 'r0', min: 5, seq: 1 }), rec({ id: 'r1', min: 125, seq: 3 })];
  const p = policy();
  const r = await run(p, p, xs);
  expect(r.window).toEqual({ sinceMs: T0, untilMs: T0 + 3 * 60 * MIN });
  expect(r.fidelity.missingInstances).toEqual([
    { instance: 'i1', hours: ['2026-11-02T11'], kind: 'no-file' },
    { instance: 'i1', hours: ['2026-11-02T10', '2026-11-02T11', '2026-11-02T12'], kind: 'seq-gap' },
    { instance: 'i2', hours: ['2026-11-02T11', '2026-11-02T12'], kind: 'heartbeats-stop' },
  ]);
});

/** The same value with the keys of every object in reverse order. */
const reverseKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(reverseKeys) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;

/** A mixed set: a reroute, budget blocks, a cut, a taint block, a label with control characters, a second tenant. */
function mixed(): LedgerLine[] {
  const secret = { rule: 'github-pat', action: 'block' as const, valueHmac: 'h9', where: 'last-turn' as const };
  return [
    { v: 1, kind: 'manifest', since: iso(T0), until: iso(T0 + 60 * MIN), instances: [{ id: 'i1', firstTs: iso(T0), lastTs: iso(T0 + 60 * MIN), records: 8, seqGaps: 0, hoursWithoutFile: [], shutdown: true }] },
    ...[0, 1, 2, 3].map((m) => rec({ id: `a${m}`, min: m, session: 'sa', repo: 'shop\u001b[31m\u009b', seq: m + 1 })),
    rec({ id: 'b0', min: 5, session: 'sb', requestClass: 'compaction', model: 'claude-haiku-5-5', cost: 50, seq: 5 }),
    rec({ id: 'b1', min: 6, session: 'sb', hits: [secret], decision: { action: 'block', reason: 'secret' }, seq: 6 }),
    rec({ id: 'b2', min: 7, session: 'sb', hits: [{ ...secret, where: 'history' }], decision: { action: 'block', reason: 'taint' }, seq: 7 }),
    rec({ id: 'c0', min: 8, session: null, team: null, seq: 8 }),
  ];
}

test('same inputs give byte-identical JSON and terminal output', async () => {
  const head = (): CompiledPolicy =>
    policy({
      revision: 'rev2',
      budgets: TEAM_DAY(0.005),
      routes: `  - { name: compaction, match: { requestClass: compaction }, chain: [b], rewriteModel: claude-sonnet-5-5, allowBodyRewrite: true, because: test }
  - { name: all, chain: [a] }`,
    });
  const a = await run(policy({ budgets: TEAM_DAY(1) }), head(), mixed());
  const b = await run(policy({ budgets: TEAM_DAY(1) }), head(), mixed());
  expect(renderJson(a)).toBe(renderJson(b));
  expect(renderTerminal(a)).toBe(renderTerminal(b));
  // Key order is fixed by the renderer, not by how the result object was built.
  expect(renderJson(reverseKeys(a) as ReplayResult)).toBe(renderJson(a));
  // Labels from client headers reach the terminal without C0, C1 or DEL characters.
  const text = renderTerminal(a);
  const controls = [...text].filter((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c <= 0x1f && ch !== '\n') || (c >= 0x7f && c <= 0x9f);
  });
  expect(controls).toEqual([]);
  expect(text).toContain('shop[31m');
  expect(renderJson(a)).toMatchSnapshot();
  expect(text).toMatchSnapshot();
});

test('ci.failOn cutSessions and costIncreasePct set gates.failed', async () => {
  const u = { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  // Opus: 1,000 * 4 + 100 * 20 = 6,000 per request. Team web has a session that the head budget cuts; the
  // team-less session only gets more expensive on fable (1,000 * 10 + 100 * 50 = 15,000).
  const xs = [
    ...[0, 1, 2].map((m) => rec({ id: `w${m}`, min: m, session: 's1', usage: u, cost: 6000 })),
    ...[3, 4, 5].map((m) => rec({ id: `n${m}`, min: m, session: 's2', team: null, usage: u, cost: 6000 })),
  ];
  const ci = 'ci:\n  failOn: { cutSessions: 0, costIncreasePct: 10 }\n';
  const base = policy({ budgets: TEAM_DAY(1), ci });
  const head = policy({
    revision: 'rev2',
    budgets: TEAM_DAY(0.012),
    ci,
    routes: '  - { name: all, chain: [a], rewriteModel: claude-fable-5-1, allowBodyRewrite: true, because: test }',
  });
  const r = await run(base, head, xs);
  expect(r.base.costMicroUsd).toBe(36_000);
  expect(r.head.costMicroUsd).toBe(60_000);
  expect(r.cutSessions.map((c) => [c.policy, c.session, c.requestIndex, c.droppedRequests])).toEqual([['head', 's1', 2, 1]]);
  expect(r.gates.failed).toEqual(['ci.failOn.cutSessions: 0', 'ci.failOn.costIncreasePct: 10']);
  expect((await run(base, base, xs)).gates.failed).toEqual([]);
});

test('the exactness table is the spec 9.3 table verbatim', () => {
  const spec = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'superpowers', 'specs', '2026-11-02-gateway-design.md'), 'utf8');
  expect(spec).toContain(EXACTNESS_TABLE);
  expect(EXACTNESS_TABLE.split('\n')).toHaveLength(10);
});

test('a guardrail settings change between base and head marks the new-rule row as applied', async () => {
  const xs = [rec({ id: 'r0', min: 0 })];
  const warn = policy({ revision: 'rev2' });
  const head = compilePolicy(
    source(`${HEAD}routes:
  - { name: all, chain: [a] }
guardrails:
  secrets: { codingAgent: warn }
failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
`),
    'rev2',
    { experimentalSubscription: false },
  );
  const row = (r: ReplayResult) => r.exactness.find((e) => e.output === 'A new guardrail rule')?.applied;
  expect(row(await run(policy(), head, xs))).toBe(true);
  expect(row(await run(policy(), warn, xs))).toBe(false);
});

// Final fix re-review residual: count_tokens passes the key's request-rate checks only since ledger 183 was overturned
// (c8ca55e). A count_tokens record written before that took no rate token when served, so replay leaves it out of the
// rate limits; a record marked decision.countTokensRateChecked replays its rate checks as served.
test('count_tokens takes a rate token in replay only when its record says the gateway rate-checked it', async () => {
  const rpm = 'rateLimits:\n  - { name: key-rpm, scope: key, rpm: 1, burst: 1 }\n';
  const base = policy({ ci: rpm });
  const head = policy({ revision: 'rev2', ci: rpm });
  const count = (id: string, sec: number, marked: boolean): TraceRecord => {
    const r = rec({ id, min: sec / 60, cost: 0, usage: null, session: `s-${id}`, ...(marked ? { decision: { countTokensRateChecked: true } } : {}) });
    return { ...r, surface: 'anthropic-count-tokens', outcome: { ...r.outcome, usageSource: 'none' } };
  };
  // Old traces: a count_tokens, then a messages request one second later on the same key, both served.
  const old = await run(base, head, [count('c0', 0, false), rec({ id: 'm1', min: 1 / 60, session: 's-m1' })]);
  expect(old.fidelity.agreement).toBe(1);
  expect(old.base).toMatchObject({ forwarded: 2, blocked: 0 });
  expect(old.head).toMatchObject({ forwarded: 2, blocked: 0 });
  // New traces: the count_tokens took the key's one token, so the messages request that follows was refused.
  const now = await run(base, head, [count('c0', 0, true), rec({ id: 'm1', min: 1 / 60, session: 's-m1', decision: { action: 'block', reason: 'rate' } })]);
  expect(now.fidelity.agreement).toBe(1);
  expect(now.head).toMatchObject({ forwarded: 1, blocked: 1 });
  expect(now.blocked).toEqual([
    { policy: 'base', reason: 'rate', name: 'key-rpm', count: 1 },
    { policy: 'head', reason: 'rate', name: 'key-rpm', count: 1 },
  ]);
});
