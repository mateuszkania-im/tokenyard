// Spec 9.3: what a forwarded request costs under a replayed policy. Exact when the model and provider stay as
// recorded (the recorded cost, or the same tokens at the policy's prices); estimated when they change. Pure.
import type { TraceRecord } from '../ledger/record.js';
import { costMicroUsd } from '../pricing/cost.js';
import { lookupModel, type PriceTable, serverToolFormat } from '../pricing/prices.js';
import type { CompiledPolicy } from '../policy/types.js';

type Usage = NonNullable<TraceRecord['outcome']['usage']>;

/** Price table id of a model (a dated id resolves to its table entry), or the name itself when unpriced. */
export const modelId = (t: PriceTable, model: string): string => lookupModel(t, model)?.id ?? model;

/** The model that answered the recorded request (the response's model, else the requested one). */
export const recordedModel = (r: TraceRecord): string => r.outcome.upstreamModel ?? r.features.model;

/**
 * Mean output tokens per model and request class over the recorded requests that have usage: the basis of the output
 * ratio when a replayed policy moves a request to another model (spec 9.3).
 */
export class OutputRatios {
  private readonly sums = new Map<string, { tokens: number; n: number }>();

  constructor(
    records: readonly TraceRecord[],
    private readonly prices: PriceTable,
  ) {
    for (const r of records) {
      const u = r.outcome.usage;
      if (u === null || r.outcome.provider === null) continue;
      const k = this.key(recordedModel(r), r.attribution.requestClass);
      const s = this.sums.get(k) ?? { tokens: 0, n: 0 };
      s.tokens += u.output;
      s.n++;
      this.sums.set(k, s);
    }
  }

  private key(model: string, requestClass: string | null): string {
    return `${modelId(this.prices, model)}\u0000${requestClass ?? ''}`;
  }

  /** Output of `to` over output of `from` for this request class; null when either was never observed. */
  ratio(from: string, to: string, requestClass: string | null): number | null {
    const a = this.sums.get(this.key(from, requestClass));
    const b = this.sums.get(this.key(to, requestClass));
    if (!a || !b || a.tokens === 0) return null;
    return b.tokens / b.n / (a.tokens / a.n);
  }
}

export interface ReplayedCost {
  /** What the request costs under this policy, micro-USD. */
  costMicroUsd: number;
  /** What settle charges the budget levels (the reservation when the recorded request was settled at its estimate). */
  chargeMicroUsd: number;
  estimated: boolean;
  modelChanged: boolean;
  /** The first switched request of a session, whose cache reads were priced as 5m cache writes. */
  cacheCold: boolean;
}

export interface CostInput {
  policy: CompiledPolicy;
  r: TraceRecord;
  /** First hop of the replayed plan. */
  provider: string;
  upstreamModel: string;
  /** The replayed reservation on each level, micro-USD. */
  estMicroUsd: number;
  /** What the gateway charges a request settled at its estimate (no final usage): `atEstimateCharge` (A2-2). */
  atEstimateMicroUsd: number;
  ratios: OutputRatios;
  /**
   * Called on a switched request with a session; true the first time for that session and target, when the cache
   * starts cold (spec 9.3: one request, then the recorded hit pattern resumes).
   */
  firstSwitch: (session: string, target: string) => boolean;
}

function price(t: PriceTable, model: string, u: Usage, r: TraceRecord): number | null {
  try {
    const fast = r.outcome.fast === true && lookupModel(t, model)?.price.fast !== undefined;
    return costMicroUsd(t, model, u, { fast, serviceTier: r.outcome.serviceTier ?? null, modifiers: r.outcome.modifiers ?? [], ...(r.outcome.serverToolUses ? { serverToolUses: r.outcome.serverToolUses, serverToolFormat: serverToolFormat(r.surface) } : {}) });
  } catch {
    return null; // unpriced model, modifier or tool under this table
  }
}

export function replayedCost(c: CostInput): ReplayedCost {
  const { r, policy } = c;
  const recorded = r.outcome.costMicroUsd ?? 0;
  const t = policy.prices;
  const same = modelId(t, c.upstreamModel) === modelId(t, recordedModel(r)) && c.provider === (r.decision.chain[0] ?? r.outcome.provider);
  const atEstimate = r.outcome.settledAtEstimate === true;
  const charge = (cost: number): number => (r.outcome.settledBy === 'sweeper' ? c.estMicroUsd : atEstimate ? c.atEstimateMicroUsd : cost);
  const result = (cost: number, estimated: boolean, cacheCold = false): ReplayedCost => ({
    costMicroUsd: cost,
    chargeMicroUsd: charge(cost),
    estimated,
    modelChanged: !same,
    cacheCold,
  });

  // Blocked when recorded: nothing ran, so there is no usage to price. Counted at zero and flagged.
  if (r.decision.action !== 'forward') return result(0, true);
  // The cost could not be computed when recorded, so the reservation was settled: this policy's reservation.
  if (atEstimate) return result(c.atEstimateMicroUsd, !same);
  const u = r.outcome.usage;
  // No usage: nothing was billed (refused upstream, unreachable), whatever the model.
  if (u === null) return result(recorded, false);
  if (same) {
    if (policy.priceTableVersion === r.outcome.priceTable) return { ...result(recorded, false), chargeMicroUsd: charge(r.outcome.chargedMicroUsd ?? recorded) };
    const repriced = price(t, recordedModel(r), u, r);
    return repriced === null ? result(recorded, true) : result(repriced, false);
  }

  // Another model or provider: output scaled by the observed ratio (kept equal without data), and the first switched
  // request of a session reads nothing from the cache: its cache reads become 5m cache writes.
  const ratio = c.ratios.ratio(recordedModel(r), c.upstreamModel, r.attribution.requestClass) ?? 1;
  const next: Usage = { ...u, output: Math.round(u.output * ratio) };
  const session = r.attribution.session;
  const cold = session !== null && c.firstSwitch(session, `${c.provider}\u0000${modelId(t, c.upstreamModel)}`);
  if (cold) {
    next.cacheWrite5m += next.cacheRead;
    next.cacheRead = 0;
  }
  const estimate = price(t, c.upstreamModel, next, r);
  return result(estimate ?? recorded, true, cold && next.cacheWrite5m > u.cacheWrite5m);
}
