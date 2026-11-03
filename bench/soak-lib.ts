// Pure pieces of `npm run soak` (V2): the pass/fail thresholds, stated before any run, and the functions that judge a
// run's samples against them (trend fits, window comparisons, Prometheus series counting, counter key classes).

/**
 * Thresholds, fixed before the first soak run (docs/benchmarks.md, "Soak"). Memory is judged after a warm-up, on two
 * measures that must both pass: the least-squares trend over the rest of the run, projected over that span, and the
 * mean of the last window against the mean of the first window after warm-up.
 */
export const SOAK_THRESHOLDS = {
  /** Seconds at the start of the load excluded from the memory trend (JIT, pools, caches filling). */
  warmupS: 300,
  /** Length of the first and last comparison windows, seconds. */
  windowS: 300,
  /** RSS and heap used after a full GC: growth over the measured span, percent of its mean. */
  memoryGrowthPct: 10,
  /** Open file descriptors, TCP sockets and active handles: idle after the run against idle before it. */
  fdSlack: 16,
  socketSlack: 8,
  handleSlack: 16,
  /** Open file descriptors during the load: the trend over the measured span, projected over it. */
  fdTrend: 16,
  /** Metric series: new series after warm-up, and the total. */
  seriesGrowth: 10,
  seriesMax: 1_000,
  /** Event loop delay p99 in every 30 s sample after warm-up, ms. */
  eventLoopP99Ms: 100,
  /** Client-side total time p50 of 2xx answers, last window against the first window after warm-up. */
  latencyDriftPct: 25,
} as const;

export interface Point {
  /** Seconds since the load started. */
  t: number;
  v: number;
}

/** Ordinary least-squares line through the points (slope per second). */
export function linearFit(points: readonly Point[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const mv = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.v - mv);
    den += (p.t - mt) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: mv - slope * mt };
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? Number.NaN : xs.reduce((s, x) => s + x, 0) / xs.length);
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

export interface Growth {
  /** Mean of the first and last windows after warm-up. */
  first: number;
  last: number;
  /** Trend slope per hour, in the sample unit. */
  slopePerHour: number;
  /** Trend over the measured span, percent of the measured mean. */
  trendPct: number;
  /** Last window against the first, percent. */
  windowPct: number;
  /** Samples after warm-up. */
  n: number;
  /** The measured span holds both windows (at least two window lengths after warm-up). */
  enough: boolean;
  ok: boolean;
}

/**
 * Growth of one measure after warm-up: passes when both the trend over the measured span and the last window against
 * the first stay under `maxPct`. A falling measure always passes. Fewer than two windows of samples fail: a run too
 * short to judge is not a pass.
 */
export function growth(samples: readonly Point[], o: { warmupS: number; windowS: number; maxPct: number }): Growth {
  const post = samples.filter((p) => p.t >= o.warmupS);
  const t0 = post[0]?.t ?? 0;
  const t1 = post.at(-1)?.t ?? 0;
  const firstW = post.filter((p) => p.t < t0 + o.windowS).map((p) => p.v);
  const lastW = post.filter((p) => p.t > t1 - o.windowS).map((p) => p.v);
  const { slope } = linearFit(post);
  const m = mean(post.map((p) => p.v));
  const trendPct = m > 0 ? ((slope * (t1 - t0)) / m) * 100 : 0;
  const first = mean(firstW);
  const last = mean(lastW);
  const windowPct = first > 0 ? ((last - first) / first) * 100 : 0;
  const enough = t1 - t0 >= 2 * o.windowS;
  return {
    first: round(first),
    last: round(last),
    slopePerHour: round(slope * 3600),
    trendPct: round(trendPct),
    windowPct: round(windowPct),
    n: post.length,
    enough,
    ok: enough && trendPct < o.maxPct && windowPct < o.maxPct,
  };
}

/**
 * Prometheus text: distinct series (a histogram's buckets, sum and count are one series; `le` is dropped) and the sum
 * of the values of each plain metric over its label sets.
 */
export function parseMetrics(text: string): { series: number; byMetric: Record<string, number>; totals: Record<string, number> } {
  const histograms = new Set<string>();
  const seen = new Set<string>();
  const byMetric: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const type = /^# TYPE (\S+) histogram$/.exec(line);
    if (type) histograms.add(type[1] as string);
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})? (\S+)$/.exec(line);
    if (!m) continue;
    let name = m[1] as string;
    const base = name.replace(/_(bucket|sum|count)$/, '');
    if (base !== name && histograms.has(base)) name = base;
    const labels = (m[2] ?? '').replace(/,?le="[^"]*"/, '').replace('{,', '{');
    const key = `${name}${labels === '{}' ? '' : labels}`;
    if (!seen.has(key)) {
      seen.add(key);
      byMetric[name] = (byMetric[name] ?? 0) + 1;
    }
    if (name === m[1]) totals[name] = (totals[name] ?? 0) + Number(m[3]);
  }
  return { series: seen.size, byMetric, totals };
}

export type KeyClass = 'budget-window' | 'budget-session' | 'rate' | 'streams' | 'taint' | 'session-marker' | 'new-sessions' | 'reservation' | 'deadlines' | 'sweep-lock' | 'r11' | 'other';

/** The class of a counter store key (src/limits/keys.ts layout); session budgets are named by the policy. */
export function classifyKey(key: string, sessionBudgets: ReadonlySet<string>): KeyClass {
  const m = /^ty:\{[^{}]*\}:(.*)$/.exec(key);
  if (!m) return 'other';
  const rest = m[1] as string;
  if (rest.startsWith('b:')) return sessionBudgets.has(decodeURIComponent(rest.split(':')[1] ?? '')) ? 'budget-session' : 'budget-window';
  if (rest.startsWith('g:')) return 'rate';
  if (rest.startsWith('st:')) return 'streams';
  if (rest.startsWith('taint:')) return 'taint';
  if (rest.startsWith('sess:')) return 'session-marker';
  if (rest.startsWith('ns:')) return 'new-sessions';
  if (rest.startsWith('res:')) return 'reservation';
  if (rest === 'deadlines') return 'deadlines';
  if (rest === 'sweep-lock') return 'sweep-lock';
  if (rest === 'r11') return 'r11';
  return 'other';
}

/** One gateway sample, every 30 s (and once idle before and after the load). */
export interface GatewaySample {
  t: number;
  rssMb: number;
  /** Heap used right after a full GC (--expose-gc), MB. */
  heapMb: number;
  externalMb: number;
  fds: number;
  tcpSockets: number;
  handles: number;
  eventLoopP50Ms: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  series: number;
  reservationsOpen: number;
  traceFiles: number;
  traceBytes: number;
}

export interface Verdict {
  check: string;
  threshold: string;
  measured: string;
  ok: boolean;
}

export interface GatewayRun {
  instance: string;
  idleBefore: GatewaySample;
  idleAfter: GatewaySample;
  samples: GatewaySample[];
  /** Counters read from /metrics after the load. */
  sweptTotal: number;
  tracesDropped: number;
  /** Trace files of this instance: hours seen, largest file. */
  traceHours: number;
  exitCode: number | null;
  /** stderr lines not on the list of expected ones. */
  unexpectedStderr: string[];
  /** Probe: uncaught exceptions seen (uncaughtExceptionMonitor). */
  uncaught: number;
}

export interface SoakJudgeInput {
  gateways: GatewayRun[];
  /** Client-side 2xx total time p50 per 30 s window. */
  latency: Point[];
  /** Stream slot check after the load: each key's limit admitted at once, and one more refused. */
  slotCheck: { keys: number; admitted: number; expectedAdmitted: number; refusedExtra: number; expectedRefused: number };
  /** Redis only: keys left after the load that must be gone, and budget reservations left. */
  redis: {
    reservationKeys: number;
    deadlineKeys: number;
    streamKeys: number;
    reservedMicroUsd: number;
    keysByClass: Record<string, number>;
    bounds: Record<string, number>;
    /** Enforced budget keys read after the load, and those whose spent is above their limit. */
    budgetKeys: number;
    overLimit: string[];
  } | null;
  /** A secret sent through one gateway, then a clean turn of the same session through another (or the same one). */
  taint: { gateways: number; refused: boolean } | null;
  failedRequests: { socket: number };
}

/** Every threshold of SOAK_THRESHOLDS applied to a finished run. */
export function judge(r: SoakJudgeInput, th: typeof SOAK_THRESHOLDS = SOAK_THRESHOLDS): Verdict[] {
  const out: Verdict[] = [];
  const g = { warmupS: th.warmupS, windowS: th.windowS, maxPct: th.memoryGrowthPct };
  for (const gw of r.gateways) {
    const at = (f: (s: GatewaySample) => number): Point[] => gw.samples.map((s) => ({ t: s.t, v: f(s) }));
    const name = (s: string): string => `${gw.instance}: ${s}`;
    for (const [label, f] of [
      ['RSS', (s: GatewaySample) => s.rssMb],
      ['heap used after GC', (s: GatewaySample) => s.heapMb],
    ] as const) {
      const x = growth(at(f), g);
      out.push({ check: name(`${label} growth`), threshold: `trend and last ${th.windowS / 60} min against first, each under ${th.memoryGrowthPct}%`, measured: `${x.first} to ${x.last} MB; trend ${x.trendPct}% (${x.slopePerHour} MB/h), windows ${x.windowPct}% (n = ${x.n})`, ok: x.ok });
    }
    const fdTrend = linearFit(at((s) => s.fds).filter((p) => p.t >= th.warmupS));
    const post = gw.samples.filter((s) => s.t >= th.warmupS);
    const span = (post.at(-1)?.t ?? 0) - (post[0]?.t ?? 0);
    const fdGrowth = Math.round(fdTrend.slope * span * 10) / 10;
    out.push({ check: name('open fds during load'), threshold: `trend over the run under ${th.fdTrend}`, measured: `${Math.min(...post.map((s) => s.fds))} to ${Math.max(...post.map((s) => s.fds))}, trend ${fdGrowth}`, ok: post.length > 0 && fdGrowth < th.fdTrend });
    for (const [label, f, slack] of [
      ['open fds', (s: GatewaySample) => s.fds, th.fdSlack],
      ['TCP sockets', (s: GatewaySample) => s.tcpSockets, th.socketSlack],
      ['active handles', (s: GatewaySample) => s.handles, th.handleSlack],
    ] as const) {
      const a = f(gw.idleBefore);
      const b = f(gw.idleAfter);
      out.push({ check: name(`${label} idle after vs before`), threshold: `at most ${slack} more`, measured: `${a} before, ${b} after`, ok: b - a <= slack });
    }
    const warmSeries = gw.samples.filter((s) => s.t <= th.warmupS).at(-1)?.series ?? gw.idleBefore.series;
    const maxSeries = Math.max(gw.idleAfter.series, ...gw.samples.map((s) => s.series));
    out.push({ check: name('metric series'), threshold: `at most ${th.seriesGrowth} new after warm-up, under ${th.seriesMax} in all`, measured: `${warmSeries} after warm-up, ${gw.idleAfter.series} at the end, ${maxSeries} at most`, ok: maxSeries - warmSeries <= th.seriesGrowth && maxSeries < th.seriesMax });
    const eld = Math.max(...post.map((s) => s.eventLoopP99Ms));
    out.push({ check: name('event loop delay p99'), threshold: `under ${th.eventLoopP99Ms} ms in every sample after warm-up`, measured: `${Math.round(eld * 100) / 100} ms at most`, ok: post.length > 0 && eld < th.eventLoopP99Ms });
    out.push({ check: name('open reservations after the load'), threshold: '0, and none settled by the sweeper', measured: `${gw.idleAfter.reservationsOpen} open, ${gw.sweptTotal} swept`, ok: gw.idleAfter.reservationsOpen === 0 && gw.sweptTotal === 0 });
    out.push({ check: name('trace records dropped'), threshold: '0', measured: String(gw.tracesDropped), ok: gw.tracesDropped === 0 });
    out.push({ check: name('process health'), threshold: 'no crash, clean exit on SIGTERM, no uncaught exception, no unexpected stderr line', measured: `exit ${gw.exitCode}, ${gw.uncaught} uncaught, ${gw.unexpectedStderr.length} unexpected stderr line(s)`, ok: gw.exitCode === 0 && gw.uncaught === 0 && gw.unexpectedStderr.length === 0 });
  }
  const lat = growth(r.latency, { warmupS: th.warmupS, windowS: th.windowS, maxPct: th.latencyDriftPct });
  out.push({ check: 'client total time p50 drift (auxiliary requests, 2xx)', threshold: `last ${th.windowS / 60} min against first under ${th.latencyDriftPct}%`, measured: `${lat.first} to ${lat.last} ms (${lat.windowPct}%)`, ok: lat.enough && lat.windowPct < th.latencyDriftPct });
  const s = r.slotCheck;
  out.push({ check: 'stream slots after the load', threshold: 'every key admits its full concurrent stream limit, and one more is refused', measured: `${s.admitted} of ${s.expectedAdmitted} admitted over ${s.keys} keys, ${s.refusedExtra} of ${s.expectedRefused} extra refused`, ok: s.admitted === s.expectedAdmitted && s.refusedExtra === s.expectedRefused });
  if (r.redis) {
    const x = r.redis;
    out.push({ check: 'Redis: reservations, deadlines and stream counts after the load', threshold: 'none left, nothing reserved', measured: `${x.reservationKeys} reservation, ${x.deadlineKeys} deadline, ${x.streamKeys} stream key(s); ${x.reservedMicroUsd} micro-USD reserved`, ok: x.reservationKeys === 0 && x.deadlineKeys === 0 && x.streamKeys === 0 && x.reservedMicroUsd === 0 });
    const over = Object.entries(x.bounds).filter(([k, bound]) => (x.keysByClass[k] ?? 0) > bound);
    out.push({ check: 'Redis: spent within the limit on every enforced budget key', threshold: 'spent at most the limit on each key after the load', measured: `${x.budgetKeys} key(s), ${x.overLimit.length} over${x.overLimit.length > 0 ? `: ${x.overLimit.slice(0, 3).join(', ')}` : ''}`, ok: x.budgetKeys > 0 && x.overLimit.length === 0 });
    out.push({ check: 'Redis: keys per class within what the load could create', threshold: 'each class at most its bound (distinct scope values sent)', measured: Object.entries(x.bounds).map(([k, b]) => `${k} ${x.keysByClass[k] ?? 0}/${b}`).join(', '), ok: over.length === 0 });
  }
  if (r.taint) {
    const across = r.taint.gateways > 1;
    out.push({ check: across ? 'session taint across gateways' : 'session taint', threshold: across ? 'a secret through one gateway taints the session on the other' : 'a secret taints the session', measured: r.taint.refused ? 'clean follow-up refused (taint)' : 'clean follow-up admitted', ok: r.taint.refused });
  }
  out.push({ check: 'client socket errors', threshold: '0 apart from deliberate aborts', measured: String(r.failedRequests.socket), ok: r.failedRequests.socket === 0 });
  return out;
}
