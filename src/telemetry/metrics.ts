// Prometheus text exposition for /metrics (spec 12.2), without OTel. Every metric is declared below with its label names:
// a label that is not declared is dropped, so a caller cannot put a session, prompt, key or request id on a metric.
// Label values are cut to printable ASCII, capped in number per label name, and escaped on output.
import { sanitizeHeaderValue } from '../report/sanitize.js';
import type { TraceRecord } from '../ledger/record.js';
import { lookupModel, type PriceTable } from '../pricing/prices.js';

type Kind = 'counter' | 'gauge' | 'histogram';
interface Def {
  kind: Kind;
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
}

const SECONDS = [0.005, 0.025, 0.1, 0.5, 1, 2.5, 10, 30, 120, 600] as const;
const TTFB_SECONDS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1] as const;

export const METRIC_DEFS = {
  tokenyard_requests_total: { kind: 'counter', help: 'Requests by route, decision (forward or block) and status class.', labels: ['route', 'decision', 'status_class'] },
  tokenyard_cost_usd_total: { kind: 'counter', help: 'Cost in USD (api-equivalent for subscription keys).', labels: ['tenant', 'team', 'route', 'request_class'] },
  tokenyard_tokens_total: { kind: 'counter', help: 'Tokens by type (input, output, cache_read, cache_write) and priced model.', labels: ['type', 'model'] },
  tokenyard_added_ttfb_seconds: { kind: 'histogram', help: 'Time to first byte added by the gateway.', labels: [], buckets: TTFB_SECONDS },
  tokenyard_inference_duration_seconds: { kind: 'histogram', help: 'Request duration by provider and priced model.', labels: ['provider', 'model'], buckets: SECONDS },
  tokenyard_time_to_first_chunk_seconds: { kind: 'histogram', help: 'Time to the first response byte by provider and priced model.', labels: ['provider', 'model'], buckets: SECONDS },
  tokenyard_cache_hit_ratio: { kind: 'gauge', help: 'Cache read tokens over all input tokens since start.', labels: [] },
  tokenyard_policy_revision_info: { kind: 'gauge', help: 'The active policy revision (value 1).', labels: ['revision'] },
  tokenyard_policy_load_errors_total: { kind: 'counter', help: 'Policy bundles that failed to load.', labels: [] },
  tokenyard_traces_dropped_total: { kind: 'counter', help: 'Trace records dropped (queue full or write failed).', labels: [] },
  tokenyard_reservations_open: { kind: 'gauge', help: 'Admitted requests of this process not yet settled.', labels: [] },
  tokenyard_bound_violations_total: { kind: 'counter', help: 'Requests whose billed input exceeded their bytes bound (R11).', labels: [] },
  tokenyard_store_down_total: { kind: 'counter', help: 'Counter store calls that failed or timed out.', labels: ['op'] },
  tokenyard_sweeper_errors_total: { kind: 'counter', help: 'Sweeper ticks that failed.', labels: [] },
  tokenyard_swept_total: { kind: 'counter', help: 'Reservations the sweeper settled at their estimate.', labels: [] },
  tokenyard_breaker_opens_total: { kind: 'counter', help: 'Circuit breaker openings by scope (provider or credential).', labels: ['scope'] },
  tokenyard_should_retry_refusals_total: { kind: 'counter', help: 'Own errors sent with x-should-retry: false, by reason.', labels: ['reason'] },
} as const satisfies Record<string, Def>;

export type MetricName = keyof typeof METRIC_DEFS;
export type Labels = Record<string, string>;

/** How many distinct values one label name keeps; later values are counted as "other". */
export const MAX_VALUES_PER_LABEL = 100;

interface Series {
  values: string[];
  value: number;
  buckets?: number[];
  sum?: number;
  count?: number;
}

export interface Metrics {
  /** Counters add `v` (default 1; negative or non-finite is ignored); gauges add `v` (may be negative). */
  inc(name: MetricName, labels?: Labels, v?: number): void;
  observe(name: MetricName, v: number, labels?: Labels): void;
  /** Sets a gauge, or a counter mirrored from a count kept elsewhere. */
  set(name: MetricName, v: number, labels?: Labels): void;
  /** Removes every series of a metric (an info gauge whose label changed). */
  reset(name: MetricName): void;
  /** Runs before each render to refresh values kept elsewhere (loader, trace writer). A throwing collector is skipped. */
  addCollector(fn: () => void): void;
  render(): string;
}

const escapeLabel = (v: string): string => v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
const escapeHelp = (v: string): string => v.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
const num = (v: number): string => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15))));

export function createMetrics(): Metrics {
  const series = new Map<string, Map<string, Series>>();
  const seen = new Map<string, Set<string>>(); // label name -> values kept
  const collectors: Array<() => void> = [];

  const seriesFor = (name: MetricName, labels: Labels | undefined): Series => {
    const def: Def = METRIC_DEFS[name];
    if (!Object.hasOwn(METRIC_DEFS, name)) throw new Error(`unknown metric ${String(name)}`);
    const values = def.labels.map((l) => {
      const raw = labels && Object.hasOwn(labels, l) ? String(labels[l]) : '';
      const v = sanitizeHeaderValue(raw).value;
      let kept = seen.get(l);
      if (!kept) seen.set(l, (kept = new Set()));
      if (kept.has(v)) return v;
      if (kept.size >= MAX_VALUES_PER_LABEL) return 'other';
      kept.add(v);
      return v;
    });
    let byKey = series.get(name);
    if (!byKey) series.set(name, (byKey = new Map()));
    const k = JSON.stringify(values);
    let s = byKey.get(k);
    if (!s) {
      s = { values, value: 0, ...(def.kind === 'histogram' ? { buckets: Array.from({ length: (def.buckets ?? []).length }, () => 0), sum: 0, count: 0 } : {}) };
      byKey.set(k, s);
    }
    return s;
  };

  return {
    inc(name, labels, v = 1) {
      if (!Number.isFinite(v)) return;
      if (METRIC_DEFS[name].kind === 'counter' && v < 0) return;
      seriesFor(name, labels).value += v;
    },
    observe(name, v, labels) {
      if (!Number.isFinite(v) || v < 0) return;
      const def: Def = METRIC_DEFS[name];
      const s = seriesFor(name, labels);
      def.buckets?.forEach((b, i) => {
        if (v <= b && s.buckets) s.buckets[i] = (s.buckets[i] ?? 0) + 1;
      });
      s.sum = (s.sum ?? 0) + v;
      s.count = (s.count ?? 0) + 1;
    },
    set(name, v, labels) {
      if (!Number.isFinite(v)) return;
      seriesFor(name, labels).value = v;
    },
    reset(name) {
      series.delete(name);
    },
    addCollector(fn) {
      collectors.push(fn);
    },
    render() {
      for (const c of collectors) {
        try {
          c();
        } catch {
          // a collector must not break the scrape
        }
      }
      const out: string[] = [];
      for (const [name, byKey] of series) {
        if (byKey.size === 0) continue;
        const def: Def = METRIC_DEFS[name as MetricName];
        out.push(`# HELP ${name} ${escapeHelp(def.help)}`, `# TYPE ${name} ${def.kind}`);
        for (const s of byKey.values()) {
          const pairs = def.labels.map((l, i) => `${l}="${escapeLabel(s.values[i] ?? '')}"`);
          const braces = (extra: string[] = []): string => (pairs.length + extra.length === 0 ? '' : `{${[...pairs, ...extra].join(',')}}`);
          if (def.kind !== 'histogram') {
            out.push(`${name}${braces()} ${num(s.value)}`);
            continue;
          }
          (def.buckets ?? []).forEach((b, i) => out.push(`${name}_bucket${braces([`le="${b}"`])} ${s.buckets?.[i] ?? 0}`));
          out.push(`${name}_bucket${braces(['le="+Inf"'])} ${s.count ?? 0}`, `${name}_sum${braces()} ${num(s.sum ?? 0)}`, `${name}_count${braces()} ${s.count ?? 0}`);
        }
      }
      return out.length === 0 ? '' : `${out.join('\n')}\n`;
    },
  };
}

/** The priced model id a model name resolves to, else "other": the model label cannot grow with client input. */
export const modelLabel = (prices: PriceTable, model: string | null | undefined): string => (model ? (lookupModel(prices, model)?.id ?? 'other') : 'other');

/**
 * Turns finished request records into metric updates. One recorder per process (it keeps the running cache hit ratio).
 * Reads only fields that hold no content: counts, names from the policy, status, timings.
 */
export function createRequestRecorder(metrics: Metrics): (r: Omit<TraceRecord, 'instance' | 'seq'>, prices: PriceTable) => void {
  let cacheRead = 0;
  let totalInput = 0;
  return (r, prices) => {
    const o = r.outcome;
    const route = r.decision.route ?? 'none';
    metrics.inc('tokenyard_requests_total', { route, decision: r.decision.action, status_class: `${Math.floor(o.status / 100)}xx` });
    if (o.addedTtfbMs !== null) metrics.observe('tokenyard_added_ttfb_seconds', o.addedTtfbMs / 1000);
    if (o.costMicroUsd !== null && o.costMicroUsd > 0) {
      metrics.inc('tokenyard_cost_usd_total', { tenant: r.tenant, team: r.team ?? '', route, request_class: r.attribution.requestClass ?? '' }, o.costMicroUsd / 1e6);
    }
    if (o.provider === null) return;
    const model = modelLabel(prices, o.upstreamModel ?? r.features.model);
    const labels = { provider: o.provider, model };
    metrics.observe('tokenyard_inference_duration_seconds', o.totalMs / 1000, labels);
    if (o.ttfbMs !== null) metrics.observe('tokenyard_time_to_first_chunk_seconds', o.ttfbMs / 1000, labels);
    const u = o.usage;
    if (!u) return;
    const write = u.cacheWrite5m + u.cacheWrite1h;
    metrics.inc('tokenyard_tokens_total', { type: 'input', model }, u.input);
    metrics.inc('tokenyard_tokens_total', { type: 'output', model }, u.output);
    metrics.inc('tokenyard_tokens_total', { type: 'cache_read', model }, u.cacheRead);
    metrics.inc('tokenyard_tokens_total', { type: 'cache_write', model }, write);
    cacheRead += u.cacheRead;
    totalInput += u.input + u.cacheRead + write;
    if (totalInput > 0) metrics.set('tokenyard_cache_hit_ratio', cacheRead / totalInput);
  };
}

/** Values that live outside the request path: refreshed at every scrape. */
export function registerCollectors(
  metrics: Metrics,
  src: { revision(): string; loadErrors?: () => number; traceDrops?: () => number },
): void {
  metrics.addCollector(() => {
    metrics.reset('tokenyard_policy_revision_info');
    metrics.set('tokenyard_policy_revision_info', 1, { revision: src.revision() });
  });
  metrics.addCollector(() => metrics.set('tokenyard_policy_load_errors_total', src.loadErrors?.() ?? 0));
  if (src.traceDrops) metrics.addCollector(() => metrics.set('tokenyard_traces_dropped_total', (src.traceDrops as () => number)()));
}
