// Spec 9.2: replay a merged trace set against a base and a head policy, each on its own simulated counter store on a
// virtual clock driven by the trace timestamps. Pure: the caller reads the files (src/policy-loader/replay-input.ts).
import type { LedgerLine, ManifestRecord, TraceRecord } from '../ledger/record.js';
import { warmupEntries } from '../limits/warmup.js';
import { budgetEnforced, decide, levelValue } from '../policy/decide.js';
import { atEstimateCharge, isAdmitted, planAdmission } from '../policy/admission.js';
import { oversizedReservation, resolve } from '../policy/resolve.js';
import { REQUEST_CLASSES } from '../policy/schema.js';
import type { Admission, BlockReason, CompiledPolicy, Plan, RequestFeatures, Surface } from '../policy/types.js';
import { modelId, OutputRatios, replayedCost, type ReplayedCost } from './cost-model.js';
import { cmp, countBy, type Exactness, exactnessRows, failedGates, type FailOn, gateThresholds } from './diff.js';
import { type ComparedDecision, disagreement, type MissingInstance, missingInstances } from './fidelity.js';
import { createSimStore } from './sim-store.js';

/** Replay was given raw per-instance trace files instead of one merged export (spec 9.2 step 1). */
export class RawTraceDirError extends Error {
  constructor(readonly path: string | null) {
    const what = path === null ? 'the traces hold lines of raw per-instance files (segment, heartbeat or shutdown records)' : `${path} is a directory of raw per-instance trace files`;
    super(`${what}; replay needs one merged set, because a partial set would undercount budgets. Run tokenyard traces export --trace-dir <dir> --since 7d --out traces.ndjson and pass that file`);
    this.name = 'RawTraceDirError';
  }
}

export interface Totals {
  costMicroUsd: number;
  costBasis: 'billed' | 'api-equivalent' | 'mixed';
  estimated: boolean;
  forwarded: number;
  blocked: number;
}

/** Not in the plan's interface: `policy` says which simulation cut the session, as in `blocked` and `budgetHits`. */
export interface CutSession {
  policy: 'base' | 'head';
  session: string;
  team: string | null;
  repo: string | null;
  requestClass: string | null;
  /** 1-based position of the blocked request among the session's requests in the window. */
  requestIndex: number;
  cause: string;
  droppedRequests: number;
  droppedCostMicroUsd: number;
}

export interface ReplayResult {
  schemaVersion: 1;
  window: { sinceMs: number; untilMs: number };
  tenant: string | null;
  requests: number;
  sessions: number;
  fidelity: { agreement: number; disagreements: Array<{ reason: string; count: number }>; missingInstances: MissingInstance[] };
  base: Totals;
  head: Totals;
  rerouted: Array<{ fromRoute: string; toRoute: string; requestClass: string | null; count: number }>;
  blocked: Array<{ policy: 'base' | 'head'; reason: BlockReason; name: string; count: number }>;
  cutSessions: CutSession[];
  budgetHits: Array<{ policy: 'base' | 'head'; budget: string; scopeValue: string; firstHitTs: string; days: number }>;
  exactness: Array<{ output: string; exactness: Exactness; applied: boolean }>;
  /** `failOn` is what the gate used: the stricter of base and head (C3); `headChangesFailOn` when the head's differs. */
  gates: { failed: string[]; failOn: FailOn; headChangesFailOn: boolean };
}

/** One record under one policy. */
interface Outcome {
  /** `exit`: ended outside the policy (before a decision, or a body the gateway could not rewrite); `dropped`: after a cut. */
  kind: 'forward' | 'block' | 'exit' | 'dropped';
  /** What fidelity compares; null when there was nothing to decide. */
  decision: ComparedDecision | null;
  reason: BlockReason | null;
  name: string;
  /** Scope value of the budget level that blocked. */
  scopeValue: string;
  provider: string | null;
  upstreamModel: string | null;
  cost: ReplayedCost | null;
}

const CLASSES: ReadonlySet<string> = new Set(REQUEST_CLASSES);
const STORE_DOWN: Admission = { admitted: false, failed: null, audit: [], totals: [], storeDown: true };
const NOTHING: Omit<Outcome, 'kind' | 'decision'> = { reason: null, name: '', scopeValue: '', provider: null, upstreamModel: null, cost: null };
/**
 * Body-shape refusals (a BOM, duplicate keys, nesting too deep, JSON that does not parse under an enforced budget): the
 * gateway answers them before decide, from body bytes the trace does not hold, so no route or chain was recorded.
 */
const SHAPE_EXITS: ReadonlySet<string> = new Set(['body-bom', 'duplicate-keys', 'too-deep', 'unparsable-body']);
/** Gateway exits that depend on body bytes the trace does not hold (or on the trace disk): carried over as recorded. */
const BODY_EXITS: ReadonlySet<string> = new Set(['redaction-failed', 'model-rewrite-failed', 'output-cap-failed', 'write-ahead-failed', ...SHAPE_EXITS]);

/** Request features exactly as the gateway decided on them: the recorded bound and its kind are used, never re-derived (R11). */
export function featuresOf(r: TraceRecord): RequestFeatures {
  const a = r.attribution;
  return {
    id: r.id,
    ts: Date.parse(r.ts),
    surface: r.surface as Surface,
    traffic: r.traffic,
    billing: r.billing,
    tenant: r.tenant,
    team: r.team,
    keyId: r.keyId,
    model: r.features.model,
    ...(r.features.modelGlobs ? { modelGlobs: [...r.features.modelGlobs] } : {}),
    stream: r.features.stream,
    inputTokensBound: r.features.inputTokensBound,
    boundKind: r.features.boundKind,
    maxOutputTokens: r.features.maxOutputTokens,
    serverTools: r.features.serverTools.map((t) => ({ type: t.type, maxUses: t.maxUses })),
    toolCount: r.features.toolCount,
    thinking: r.features.thinking,
    fastMode: r.features.fastMode === true,
    ...(r.features.compaction === true ? { compaction: true } : {}),
    ...(r.features.serviceTier !== undefined ? { serviceTier: r.features.serviceTier } : {}),
    attribution: {
      session: a.session,
      agent: a.agent,
      parentAgent: a.parentAgent,
      requestClass: a.requestClass !== null && CLASSES.has(a.requestClass) ? (a.requestClass as RequestFeatures['attribution']['requestClass']) : null,
      agentType: a.agentType,
      promptId: a.promptId,
      repo: a.repo,
      branch: a.branch,
      ticket: a.ticket,
      feature: a.feature,
    },
    guardrail: { hits: r.guardrail.hits.map((h) => ({ rule: h.rule, action: h.action, valueHmac: h.valueHmac, where: h.where })) },
  };
}


const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort(cmp);

/** What blocked, by name: the budget, limit or rule, the model, or the server tools. */
function blockName(plan: Plan, f: RequestFeatures, reason: BlockReason, admission: Admission | null): string {
  const failed = admission?.failed ?? null;
  switch (reason) {
    case 'budget':
      return failed?.kind === 'budget' ? failed.name : (oversizedReservation(plan)?.budget ?? '');
    case 'rate':
    case 'streams':
      return failed?.name ?? '';
    case 'taint':
      return failed?.rule ?? failed?.name ?? '';
    case 'secret':
      return uniqSorted((plan.taint?.add ?? []).map((a) => a.rule)).join(', ');
    case 'model-not-allowed':
      return f.model;
    case 'unpriced':
      return plan.chain[0]?.upstreamModel ?? f.model;
    case 'server-tool-not-allowed':
      return uniqSorted(plan.warnings.flatMap((w) => (w.kind === 'server-tool-not-allowed' ? [w.type] : []))).join(', ');
    case 'server-tool-no-max-uses':
      return uniqSorted(f.serverTools.filter((t) => t.maxUses === null).map((t) => t.type)).join(', ');
    default:
      return '';
  }
}

async function* iterate(xs: readonly TraceRecord[]): AsyncIterable<LedgerLine> {
  yield* xs;
}

/**
 * The order the store saw the records in: each at the time its admit was called (ts plus the recorded offset; the
 * body is read and scanned first, so a large body admits after a small one that started later), then by instance,
 * process epoch and the process's admit call number for admits in the same millisecond, then by ts and id. Records
 * without an admit take their ts.
 */
export function admitOrder(window: readonly TraceRecord[]): Array<{ i: number; at: number }> {
  return window
    .map((r, i) => ({ i, at: Date.parse(r.ts) + Math.max(0, r.decision.admitOffsetMs ?? 0), r }))
    .sort((a, b) => a.at - b.at || cmp(a.r.instance, b.r.instance) || cmp(a.r.decision.seqEpoch ?? '', b.r.decision.seqEpoch ?? '') || (a.r.decision.admitSeq ?? 0) - (b.r.decision.admitSeq ?? 0) || a.i - b.i)
    .map(({ i, at }) => ({ i, at }));
}

/**
 * The (instance, process epoch) whose admit counts a record's admitSeq and settleSeq are, or null for a record written
 * without an epoch: its counts are not compared with any other record's.
 */
const counter = (r: TraceRecord): string | null => (r.decision.seqEpoch === undefined ? null : `${r.instance}\u0000${r.decision.seqEpoch}`);

interface Pending {
  at: number;
  order: number;
  id: string;
  amount: number;
  /** The recording process (instance and epoch) and its admit count when it settled; null or absent in older traces. */
  counter: string | null;
  settleSeq: number | undefined;
}

/**
 * Whether a pending settle lands before `next`. A settle carrying `settleSeq` (the admits its process had issued when
 * it called settle) is ordered exactly against the admits of the same process, that is the same instance and process
 * epoch, since totalMs is measured before settle and a later admit can share its millisecond (V4): before an admit
 * numbered `admitSeq` only when settleSeq is lower; before a record of that process that called no admit only once
 * the admit numbered settleSeq was replayed (`lastSeq`). Against another instance, another process of the same
 * instance (the admit count restarts with the process while `--instance-id` may not, V4 review I1), and in traces
 * written without settleSeq or without an epoch, the recorded end decides.
 */
function settlesBefore(p: Pending, until: number, next: TraceRecord | null, lastSeq: ReadonlyMap<string, number>): boolean {
  if (p.at > until) return false;
  if (next === null || p.settleSeq === undefined || p.counter === null || p.counter !== counter(next)) return true;
  const seq = next.decision.admitSeq;
  return seq !== undefined ? p.settleSeq < seq : p.settleSeq <= (lastSeq.get(p.counter) ?? 0);
}

/**
 * Spec 9.2 steps 3, 4 and 6 for one policy: decide, admit and resolve each record as the gateway does, settle it at
 * its recorded end, and drop the rest of a session once this policy blocks a request the gateway forwarded after the
 * session had a forwarded request (a cut; assumption: the agent stops).
 */
async function simulate(
  policy: CompiledPolicy,
  which: 'base' | 'head',
  window: readonly TraceRecord[],
  warm: readonly TraceRecord[],
  startMs: number,
  ratios: OutputRatios,
): Promise<{ outcomes: Outcome[]; cuts: CutSession[] }> {
  let now = startMs;
  const store = createSimStore(() => now);
  await store.seed(await warmupEntries(iterate(warm), policy, startMs));
  const pending: Pending[] = [];
  let order = 0;
  const schedule = (r: TraceRecord, at: number, amount: number): void => {
    const p = { at, order: order++, id: r.id, amount, counter: counter(r), settleSeq: r.outcome.settleSeq };
    let i = pending.length;
    while (i > 0 && (pending[i - 1] as Pending).at > at) i--;
    pending.splice(i, 0, p);
  };
  /** Highest admitSeq replayed per process (instance and epoch). */
  const lastSeq = new Map<string, number>();
  // A settle whose end has come but which the instance called after `next`'s admit stays pending (settlesBefore).
  const drain = async (until: number, next: TraceRecord | null): Promise<void> => {
    for (let i = 0; i < pending.length && (pending[i] as Pending).at <= until; ) {
      const p = pending[i] as Pending;
      if (!settlesBefore(p, until, next, lastSeq)) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      now = p.at;
      await store.settle(p.id, p.amount);
    }
  };
  const switched = new Set<string>();
  const firstSwitch = (session: string, target: string): boolean => {
    const k = `${session}\u0000${target}`;
    if (switched.has(k)) return false;
    switched.add(k);
    return true;
  };

  const one = async (r: TraceRecord, admitMs: number): Promise<Outcome> => {
    // Refused before decide: carried over as recorded whatever this policy would decide (normally marked preDecision).
    if (r.decision.reason !== null && SHAPE_EXITS.has(r.decision.reason)) return { ...NOTHING, kind: 'exit', decision: { action: 'block', reason: r.decision.reason, route: null, chain: [] } };
    const f = featuresOf(r);
    let plan: Plan;
    try {
      plan = decide(policy, f);
      // count_tokens took no rate token before ledger 183 was overturned: a record from then replays as it was served.
      if (f.surface === 'anthropic-count-tokens' && r.decision.countTokensRateChecked !== true) plan = { ...plan, rateChecks: [] };
    } catch {
      // The gateway answers 500 and reserves nothing when the reservation cannot be computed.
      return { ...NOTHING, kind: 'exit', decision: { action: 'block', reason: 'reservation-error', route: null, chain: [] } };
    }
    const compared = (action: 'forward' | 'block', reason: string | null): ComparedDecision => ({ action, reason, route: plan.route, chain: plan.chain.map((c) => c.provider) });
    const bodyExit = plan.preBlock === null && r.decision.reason !== null && BODY_EXITS.has(r.decision.reason) && (r.decision.reason !== 'model-rewrite-failed' || plan.chain[0]?.rewritesModel === true) && (r.decision.reason !== 'output-cap-failed' || plan.outputCap !== undefined);
    if (bodyExit) return { ...NOTHING, kind: 'exit', decision: compared('block', r.decision.reason) };

    // Spec 5.3 steps 7 and 8, as src/edge/handler.ts runs them. A store that was down when recorded is down here too.
    const { pre, callsAdmit } = planAdmission(policy, plan);
    let admission: Admission | null = null;
    if (callsAdmit) admission = r.decision.storeDown ? STORE_DOWN : await store.admit(plan, admitMs);
    const admitted = isAdmitted(plan, admission);
    const decision = admission === null ? pre : resolve(policy, plan, admission);
    const first = plan.chain[0];
    const provider = first === undefined ? undefined : policy.providers.get(first.provider);
    const end = Math.max(admitMs, Date.parse(r.ts) + Math.max(0, r.outcome.totalMs));
    const est = plan.reservations[0]?.estMicroUsd ?? 0;
    if (decision.block !== null || first === undefined || provider === undefined) {
      const reason: BlockReason = decision.block?.reason ?? 'no-route';
      if (admitted) schedule(r, end, 0);
      let scopeValue = '';
      if (reason === 'budget') {
        const name = blockName(plan, f, reason, admission);
        const b = policy.budgets.find((x) => x.name === name);
        scopeValue = b === undefined ? '' : (levelValue(b.scope, f, budgetEnforced(b, f.billing)) ?? '');
      }
      return { ...NOTHING, kind: 'block', decision: compared('block', reason), reason, name: blockName(plan, f, reason, admission), scopeValue };
    }
    const cost = replayedCost({ policy, r, provider: first.provider, upstreamModel: first.upstreamModel, estMicroUsd: est, atEstimateMicroUsd: atEstimateCharge(plan, est), ratios, firstSwitch });
    if (admitted) schedule(r, end, cost.chargeMicroUsd);
    return { ...NOTHING, kind: 'forward', decision: compared('forward', null), provider: first.provider, upstreamModel: first.upstreamModel, cost };
  };

  const outcomes: Outcome[] = [];
  const cuts: CutSession[] = [];
  const sessions = new Map<string, { index: number; forwarded: boolean; cut: CutSession | null }>();
  for (const { i, at: ms } of admitOrder(window)) {
    const r = window[i] as TraceRecord;
    await drain(ms, r);
    now = ms;
    const seq = r.decision.admitSeq;
    const c = counter(r);
    if (seq !== undefined && c !== null) lastSeq.set(c, Math.max(seq, lastSeq.get(c) ?? 0));
    const session = r.attribution.session;
    let s: { index: number; forwarded: boolean; cut: CutSession | null } | null = null;
    if (session !== null) {
      s = sessions.get(session) ?? { index: 0, forwarded: false, cut: null };
      sessions.set(session, s);
      s.index++;
    }
    if (s?.cut) {
      s.cut.droppedRequests++;
      s.cut.droppedCostMicroUsd += r.outcome.costMicroUsd ?? 0;
      outcomes[i] = { ...NOTHING, kind: 'dropped', decision: null };
      continue;
    }
    if (r.decision.preDecision) {
      outcomes[i] = { ...NOTHING, kind: 'exit', decision: null };
      continue;
    }
    const o = await one(r, ms);
    outcomes[i] = o;
    if (s === null) continue;
    if (o.kind === 'forward') s.forwarded = true;
    // A block the recording also had is not a cut: the recorded session went on after it.
    if (o.kind === 'block' && s.forwarded && r.decision.action === 'forward') {
      s.cut = {
        policy: which,
        session: session as string,
        team: r.team,
        repo: r.attribution.repo,
        requestClass: r.attribution.requestClass,
        requestIndex: s.index,
        cause: o.name === '' ? (o.reason as string) : `${o.reason as string} ${o.name}`,
        droppedRequests: 0,
        droppedCostMicroUsd: 0,
      };
      cuts.push(s.cut);
    }
  }
  await drain(Number.POSITIVE_INFINITY, null);
  return { outcomes, cuts };
}

function totals(outcomes: readonly Outcome[], window: readonly TraceRecord[]): Totals {
  let costMicroUsd = 0;
  let estimated = false;
  let forwarded = 0;
  let blocked = 0;
  const bases = new Set<string>();
  outcomes.forEach((o, i) => {
    if (o.kind === 'block') blocked++;
    if (o.kind !== 'forward' || o.cost === null) return;
    forwarded++;
    costMicroUsd += o.cost.costMicroUsd;
    estimated ||= o.cost.estimated;
    bases.add((window[i] as TraceRecord).outcome.costBasis);
  });
  const costBasis = bases.size > 1 ? 'mixed' : bases.has('api-equivalent') ? 'api-equivalent' : 'billed';
  return { costMicroUsd, costBasis, estimated, forwarded, blocked };
}

const recordedDecision = (r: TraceRecord): ComparedDecision => ({ action: r.decision.action, reason: r.decision.reason, route: r.decision.route, chain: [...r.decision.chain] });

export async function replay(o: { base: CompiledPolicy; head: CompiledPolicy; traces: AsyncIterable<LedgerLine>; sinceMs: number | null; tenant: string | null }): Promise<ReplayResult> {
  // Step 1: one merged set, ordered by ts, then id.
  const manifests: ManifestRecord[] = [];
  const all: Array<{ ms: number; r: TraceRecord }> = [];
  for await (const line of o.traces) {
    if (line.kind === 'manifest') manifests.push(line);
    else if (line.kind === 'request') {
      const ms = Date.parse(line.ts);
      if (!Number.isNaN(ms) && (o.tenant === null || line.tenant === o.tenant)) all.push({ ms, r: line });
    } else throw new RawTraceDirError(null);
  }
  all.sort((a, b) => a.ms - b.ms || cmp(a.r.id, b.r.id));
  const firstManifest = manifests[0];
  const sinceMs = o.sinceMs ?? (firstManifest ? Date.parse(firstManifest.since) : (all[0]?.ms ?? 0));
  const untilMs = firstManifest ? Math.max(...manifests.map((m) => Date.parse(m.until))) : (all.at(-1)?.ms ?? sinceMs);
  const warm = all.filter((x) => x.ms < sinceMs).map((x) => x.r);
  const window = all.filter((x) => x.ms >= sinceMs).map((x) => x.r);

  // Steps 2 to 4 and 6: each policy on its own simulated store.
  const base = await simulate(o.base, 'base', window, warm, sinceMs, new OutputRatios([...warm, ...window], o.base.prices));
  const head = await simulate(o.head, 'head', window, warm, sinceMs, new OutputRatios([...warm, ...window], o.head.prices));

  // Step 5: fidelity over the records the base revision recorded.
  let compared = 0;
  const reasons: string[] = [];
  window.forEach((r, i) => {
    const replayed = base.outcomes[i]?.decision ?? null;
    if (r.policy.revision !== o.base.revision || r.decision.preDecision || replayed === null) return;
    compared++;
    const d = disagreement(recordedDecision(r), replayed);
    if (d !== null) reasons.push(d);
  });
  const disagreements = countBy(reasons, (x) => [x])
    .map((g) => ({ reason: g.item, count: g.count }))
    .sort((a, b) => b.count - a.count || cmp(a.reason, b.reason));
  if (compared === 0) disagreements.push({ reason: `no request in the window was recorded under the base revision ${o.base.revision}`, count: window.length });
  const agreement = compared === 0 ? 0 : (compared - reasons.length) / compared;

  // Step 4 and 9.4: what the head changes against the base.
  const rerouted: Array<{ fromRoute: string; toRoute: string; requestClass: string | null }> = [];
  window.forEach((r, i) => {
    const b = base.outcomes[i];
    const h = head.outcomes[i];
    if (b?.kind !== 'forward' || h?.kind !== 'forward') return;
    const route = (x: Outcome): string => x.decision?.route ?? '(none)';
    if (route(b) !== route(h)) rerouted.push({ fromRoute: route(b), toRoute: route(h), requestClass: r.attribution.requestClass });
    else if (b.provider !== h.provider || modelId(o.head.prices, b.upstreamModel ?? '') !== modelId(o.head.prices, h.upstreamModel ?? '')) {
      const hop = (x: Outcome): string => `${route(x)} (${x.provider ?? ''}, ${x.upstreamModel ?? ''})`;
      rerouted.push({ fromRoute: hop(b), toRoute: hop(h), requestClass: r.attribution.requestClass });
    }
  });
  const both = [
    { which: 'base' as const, outcomes: base.outcomes },
    { which: 'head' as const, outcomes: head.outcomes },
  ];
  const blocks = both.flatMap(({ which, outcomes }) => outcomes.flatMap((x, i) => (x.kind === 'block' ? [{ which, x, r: window[i] as TraceRecord }] : [])));
  const blocked = countBy(blocks, (b) => [b.which, b.x.reason as string, b.x.name])
    .map((g) => ({ policy: g.item.which, reason: g.item.x.reason as BlockReason, name: g.item.x.name, count: g.count }))
    .sort((a, b) => cmp(a.policy, b.policy) || b.count - a.count || cmp(a.reason, b.reason) || cmp(a.name, b.name));
  const hits = new Map<string, { policy: 'base' | 'head'; budget: string; scopeValue: string; firstMs: number; days: Set<string> }>();
  for (const b of blocks) {
    if (b.x.reason !== 'budget') continue;
    const k = [b.which, b.x.name, b.x.scopeValue].join('\u0000');
    const ms = Date.parse(b.r.ts);
    const h = hits.get(k) ?? { policy: b.which, budget: b.x.name, scopeValue: b.x.scopeValue, firstMs: ms, days: new Set<string>() };
    h.firstMs = Math.min(h.firstMs, ms);
    h.days.add(b.r.ts.slice(0, 10));
    hits.set(k, h);
  }
  const budgetHits = [...hits.values()]
    .sort((a, b) => cmp(a.policy, b.policy) || cmp(a.budget, b.budget) || cmp(a.scopeValue, b.scopeValue))
    .map((h) => ({ policy: h.policy, budget: h.budget, scopeValue: h.scopeValue, firstHitTs: new Date(h.firstMs).toISOString(), days: h.days.size }));

  const forwardedCosts = [...base.outcomes, ...head.outcomes].flatMap((x) => (x.kind === 'forward' && x.cost ? [x.cost] : []));
  const baseTotals = totals(base.outcomes, window);
  const headTotals = totals(head.outcomes, window);
  const counterBlock = blocks.some((b) => b.x.reason === 'budget' || b.x.reason === 'rate' || b.x.reason === 'streams');
  const switchedModel = forwardedCosts.some((c) => c.modelChanged);
  const exactness = exactnessRows({
    routes: window.length > 0,
    counters: counterBlock || base.cuts.length + head.cuts.length > 0,
    costSameModel: forwardedCosts.some((c) => !c.modelChanged),
    costModelChange: switchedModel,
    cacheSwitch: forwardedCosts.some((c) => c.cacheCold),
    guardrailChange: JSON.stringify(o.base.guardrails) !== JSON.stringify(o.head.guardrails),
    switched: switchedModel,
  });

  const gate = gateThresholds(o.base.ci.failOn, o.head.ci.failOn);
  return {
    schemaVersion: 1,
    window: { sinceMs, untilMs },
    tenant: o.tenant,
    requests: window.length,
    sessions: new Set(window.flatMap((r) => (r.attribution.session === null ? [] : [r.attribution.session]))).size,
    fidelity: { agreement, disagreements, missingInstances: missingInstances(manifests, window) },
    base: baseTotals,
    head: headTotals,
    rerouted: countBy(rerouted, (x) => [x.fromRoute, x.toRoute, x.requestClass ?? '\u0000'])
      .map((g) => ({ ...g.item, count: g.count }))
      .sort((a, b) => b.count - a.count || cmp(a.fromRoute, b.fromRoute) || cmp(a.toRoute, b.toRoute) || cmp(a.requestClass ?? '', b.requestClass ?? '')),
    blocked,
    cutSessions: [...base.cuts, ...head.cuts],
    budgetHits,
    exactness,
    gates: { failed: failedGates(gate.failOn, { headCuts: head.cuts.length, baseCost: baseTotals.costMicroUsd, headCost: headTotals.costMicroUsd }), failOn: gate.failOn, headChangesFailOn: gate.changed },
  };
}
