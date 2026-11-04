#!/usr/bin/env node
// Copies bench/results.json into the README between the BENCH markers (spec 12.3), or checks that the block there is
// exactly what the results render to. The check never measures anything: it only compares text.
//   node scripts/bench-to-readme.mjs --write README.md [--results bench/results.json]
//   node scripts/bench-to-readme.mjs --check README.md [--results bench/results.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BENCH_START = '<!-- BENCH:START -->';
export const BENCH_END = '<!-- BENCH:END -->';

/** Fixed-point with thousands separators, independent of the locale. */
function num(n, digits = 0) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  const [int, frac] = Math.abs(n).toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 && Number(Math.abs(n).toFixed(digits)) !== 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}
const usd = (n, digits = 2) => (typeof n === 'number' ? `$${num(n, digits)}` : 'n/a');
const ms = (n) => num(n, 2);
const triple = (p) => `${ms(p.p50)} / ${ms(p.p95)} / ${ms(p.p99)}`;
const pair = (p) => `${ms(p.p50)} / ${ms(p.p99)}`;
const ratio = (r) => (r ? `${num(r.min, 2)} / ${num(r.median, 2)} / ${num(r.max, 2)}` : 'n/a');
const verdict = (met) => (met === true ? 'met' : met === false ? 'missed' : 'not measured');
/** Answered requests and output tokens per second, direct / through the gateway; n/a for results measured before V1. */
const rate = (t) => (t ? `${num(t.direct.requestsPerS, 1)} / ${num(t.gateway.requestsPerS, 1)} req/s, ${num(t.direct.outputTokensPerS)} / ${num(t.gateway.outputTokensPerS)} tokens/s` : 'n/a');
const SCENARIOS = { 'non-streaming': 'Non-streaming, small body', 'streaming-500': 'Streaming, 500 tokens', 'body-150kb': 'Streaming, 150 KB body' };

function overheadTable(rows) {
  const out = [
    '| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Total time p50 / p99 (ms), direct | Same, through the gateway | Throughput, direct / gateway | Gateway CPU | Gateway RSS growth | Errors (direct / gateway) |',
    '|---|---:|---|---|---|---|---|---|---:|---:|---:|',
  ];
  for (const r of rows) {
    out.push(
      `| ${SCENARIOS[r.scenario] ?? r.scenario} | ${num(r.concurrency)} | ${triple(r.addedTtfb)} (n = ${num(r.addedTtfb.n)}) | ${pair(r.direct.outsideProvider)} | ${pair(r.gateway.outsideProvider)} | ${pair(r.direct.total)} | ${pair(r.gateway.total)} | ${rate(r.throughput)} | ${num(r.gatewayCpuPct, 1)}% | ${num(r.rssGrowthMb, 1)} MB | ${num(r.errors.direct)} / ${num(r.errors.gateway)} |`,
    );
  }
  return out.join('\n');
}

const LOW_N = 200;
const SLO_LEVELS = [10, 100, 500];

/** Which of the four values of a row miss the added TTFB targets (under 5 ms p50, under 25 ms p99). */
function missedMeasures(r) {
  const which = (label, p) => {
    const m = [p.p50 !== null && p.p50 >= 5 ? 'p50' : null, p.p99 !== null && p.p99 >= 25 ? 'p99' : null].filter(Boolean);
    return m.length > 0 ? `${label} ${m.join(' and ')}` : null;
  };
  return [which('gateway-measured', r.addedTtfb), which('client-side', r.gateway.outsideProvider)].filter(Boolean).join(', ');
}

/** The rows that miss the added TTFB targets, generated from the results so the text cannot drift from them. */
function missesNote(rows) {
  const item = (r) => {
    const why = [missedMeasures(r), r.saturated ? 'gateway saturated' : null, r.addedTtfb.n < LOW_N ? `n = ${num(r.addedTtfb.n)}` : null].filter(Boolean).join('; ');
    return `${SCENARIOS[r.scenario] ?? r.scenario}, ${r.store} store, ${num(r.concurrency)} ${r.concurrency === 1 ? 'stream' : 'streams'} (${why})`;
  };
  const missed = rows.filter((r) => r.addedTtfbMet === false);
  const list = (xs) => (xs.length > 0 ? xs.map(item).join('; ') : 'none');
  const atSlo = missed.filter((r) => SLO_LEVELS.includes(r.concurrency));
  const other = missed.filter((r) => !SLO_LEVELS.includes(r.concurrency));
  return [`Rows that miss the added TTFB targets at the SLO levels (10, 100 and 500 streams): ${list(atSlo)}.`, ...(rows.some((r) => !SLO_LEVELS.includes(r.concurrency)) ? [`At the other levels: ${list(other)}.`] : [])].join(' ');
}

function overheadSection(o) {
  const main = [10, 100, 500];
  const lines = [
    '#### Gateway overhead',
    '',
    `${o.method}`,
    '',
    'Errors count non-2xx answers and socket errors; scheduled requests the run could not send within its drain time are listed as dropped in bench/results.json.',
    '',
  ];
  for (const store of ['memory', 'redis']) {
    const rows = o.rows.filter((r) => r.store === store);
    lines.push(`${store === 'memory' ? 'Memory' : 'Redis'} store:`, '');
    if (rows.length === 0) {
      lines.push(store === 'redis' ? `${o.redis}.` : 'not measured.', '');
      continue;
    }
    const shown = rows.filter((r) => main.includes(r.concurrency));
    lines.push(overheadTable(shown.length > 0 ? shown : rows), '');
  }
  if (o.slopes && o.slopes.length > 0) {
    lines.push('Gateway cost per 100 more streams (slope between two levels):', '', '| Store | Scenario | Streams | CPU per 100 streams | RSS growth per 100 streams |', '|---|---|---|---:|---:|');
    for (const x of o.slopes) lines.push(`| ${x.store} | ${SCENARIOS[x.scenario] ?? x.scenario} | ${num(x.from)} to ${num(x.to)} | ${num(x.cpuPctPer100Streams, 1)}%${x.saturated ? ' (gateway saturated at ' + num(x.to) + ' streams, so this understates it)' : ''} | ${num(x.rssMbPer100Streams, 1)} MB |`);
    lines.push('');
  }
  if (o.rows.some((r) => !main.includes(r.concurrency))) {
    lines.push('<details><summary>Every concurrency level, with client-side TTFB from the scheduled send time</summary>', '');
    lines.push(
      '| Store | Scenario | Streams | Rate per stream (req/s) | Seconds | Answered (direct / gateway) | Answered req/s (direct / gateway) | Output tokens/s (direct / gateway) | Added TTFB p50 / p95 / p99 (ms) | TTFB outside the provider p50 / p99 (ms), direct / gateway | TTFB p50 / p95 / p99 (ms), direct | Same, through the gateway | Gateway CPU | Gateway RSS | Added TTFB target (both measures) |',
      '|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---:|---:|---|',
    );
    for (const r of o.rows) {
      lines.push(
        `| ${r.store} | ${SCENARIOS[r.scenario] ?? r.scenario} | ${num(r.concurrency)}${r.addedTtfb.n < LOW_N ? ' (low n)' : ''} | ${num(r.ratePerConnection, 2)} | ${num(r.durationS)} | ${num(r.requests.direct)} / ${num(r.requests.gateway)} | ${r.throughput ? `${num(r.throughput.direct.requestsPerS, 1)} / ${num(r.throughput.gateway.requestsPerS, 1)}` : 'n/a'} | ${r.throughput ? `${num(r.throughput.direct.outputTokensPerS)} / ${num(r.throughput.gateway.outputTokensPerS)}` : 'n/a'} | ${triple(r.addedTtfb)} | ${pair(r.direct.outsideProvider)} / ${pair(r.gateway.outsideProvider)} | ${triple(r.direct.ttfb)} | ${triple(r.gateway.ttfb)} | ${num(r.gatewayCpuPct, 1)}% | ${num(r.gatewayRssMb, 1)} MB | ${verdict(r.addedTtfbMet)} |`,
      );
    }
    lines.push('', '</details>', '');
  }
  if (o.rows.some((r) => r.addedTtfbMet !== undefined)) {
    lines.push(missesNote(o.rows), '');
  }
  return lines.join('\n');
}

const pcts = (xs) => (xs ?? []).map((x) => `${num(x, 1)}%`).join(', ');

/** The multi-worker rows (`serve --workers`, Redis store): their own table, so the single-process tables stay as they are. */
function workersSection(w) {
  const lines = ['#### Gateway overhead with several gateway processes (`serve --workers`, Redis store)', ''];
  if (!w.rows) {
    lines.push(`${w.notMeasured}.`, '');
    return lines.join('\n');
  }
  lines.push(
    `${w.method}`,
    '',
    '| Scenario | Streams | Gateway processes | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Throughput, direct / gateway | Gateway CPU (per process) | Mock CPU per process | Load generator CPU per process | Errors (direct / gateway) | Added TTFB target (both measures) |',
    '|---|---:|---:|---|---|---|---|---:|---|---|---:|---|',
  );
  for (const r of w.rows) {
    lines.push(
      `| ${SCENARIOS[r.scenario] ?? r.scenario} | ${num(r.concurrency)} | ${num(r.workers)} | ${triple(r.addedTtfb)} (n = ${num(r.addedTtfb.n)}) | ${pair(r.direct.outsideProvider)} | ${pair(r.gateway.outsideProvider)} | ${rate(r.throughput)} | ${num(r.gatewayCpuPct, 1)}%${r.perProcessCpuPct ? ` (${pcts(r.perProcessCpuPct)})` : ''} | ${pcts(r.mockCpuPct.gateway)} | ${pcts(r.loadCpuPct.gateway)} | ${num(r.errors.direct)} / ${num(r.errors.gateway)} | ${verdict(r.addedTtfbMet)} |`,
    );
  }
  if (w.note) lines.push('', w.note);
  lines.push('');
  return lines.join('\n');
}

function budgetSection(b) {
  const lines = [
    '#### Budget correctness',
    '',
    'The G4 proof scenario of spec 7.4: requests sent at the same moment, each on its own connection opened beforehand, through the gateway against one enforced budget, each with an actual cost drawn (seeded) between 0 and its limits. "Admit calls before the first settle" counts the requests the store decided while the first admitted ones were still open.',
    '',
    '| Store | Estimator | Budget | Requests sent at once | Admit calls before the first settle | Most open reservations | Admitted | Rejected | Final spend | Max spent + reserved after any admit | Max overspend | Final spend minus settled costs | Reserved left |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of b.runs) {
    lines.push(
      `| ${r.store} | ${r.estimator} | ${usd(r.limitUsd)} | ${num(r.requests)} | ${num(r.admitsBeforeFirstSettle)} | ${num(r.maxOpenReservations)} | ${num(r.admitted)} | ${num(r.rejected)} | ${usd(r.finalSpentUsd, 6)} | ${usd(r.maxSpentPlusReservedUsd, 6)} | ${usd(r.maxOverspendUsd, 6)} | ${num(r.spendDriftMicroUsd)} micro-USD | ${num(r.reservedLeftMicroUsd)} micro-USD |`,
    );
  }
  if (b.notMeasured) lines.push('', `${b.notMeasured}.`);
  const h = b.headroom;
  if (h) {
    lines.push(
      '',
      `Concurrency trade-off: one ${num(h.bodyBytes)}-byte turn with max_tokens ${num(h.maxTokens)} on ${h.model}, sent concurrently in one session under a ${usd(h.sessionBudgetUsd)} session budget (enforced), while the mock holds every stream open:`,
      '',
      '| Estimator | Reservation per turn | Turns admitted in flight |',
      '|---|---:|---:|',
    );
    for (const r of h.rows) lines.push(`| ${r.estimator} | ${usd(r.reservationUsd, 4)} | ${num(r.inFlightAdmitted)} of ${num(r.sent)} |`);
    if (h.note) lines.push('', h.note);
  }
  lines.push('');
  return lines.join('\n');
}

function cacheSection(c) {
  const lines = [
    '#### Cache economics',
    '',
    `The ${num(c.turns)}-turn Claude Code shaped session of conformance test C15, priced at ${c.model} list prices:`,
    '',
    '| Path | Session cost | Uncached input tokens | Cache read tokens | Cache write tokens | Cache hit ratio |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const r of c.rows) {
    lines.push(`| ${r.path} | ${usd(r.costUsd, 4)} | ${num(r.inputTokens)} | ${num(r.cacheReadTokens)} | ${num(r.cacheWriteTokens)} | ${num(r.cacheHitRatio * 100, 2)}% |`);
  }
  if (c.note) lines.push('', c.note);
  lines.push('');
  return lines.join('\n');
}

function scanSection(s) {
  return [
    '#### Secret scan',
    '',
    `Default rules on a ${num(s.bodyMb, 1)} MiB synthetic coding-agent body: last-turn scan ${num(s.lastTurnMbPerS, 1)} MiB/s, full-body scan ${num(s.fullBodyMbPerS, 1)} MiB/s. False-positive corpus (source trees and lockfiles sent as tool results): ${num(s.fpCorpus.files)} files, ${num(s.fpCorpus.mb, 1)} MB, ${num(s.fpCorpus.blockHits)} block hits.`,
    '',
  ].join('\n');
}

function replaySection(r) {
  return [
    '#### Replay throughput',
    '',
    `${num(r.records)} synthetic trace records (the demo week repeated, ${num(r.fileMb, 1)} MB gzipped export) read, parsed and replayed against the demo's base and head policies in ${num(r.seconds, 1)} s (${num(r.recordsPerSecond)} records/s, fidelity ${num(r.fidelityAgreement * 100, 1)}%).`,
    '',
  ].join('\n');
}

function calibrationSection(c) {
  const lines = [
    '#### Estimator calibration',
    '',
    '| Traces | Requests with usage | Bounds (bytes / context-window) | Bytes bound to billed input, min / median / max | Reservation to actual cost, min / median / max | Billed input above bound |',
    '|---|---:|---:|---|---|---:|',
  ];
  for (const s of c.sources) {
    lines.push(`| ${s.label} | ${num(s.requests)} | ${num(s.boundKinds.bytes)} / ${num(s.boundKinds['context-window'])} | ${ratio(s.boundToActual)} | ${ratio(s.reservationToCost)} | ${num(s.violations)} |`);
  }
  if (c.note) lines.push('', c.note);
  lines.push('');
  return lines.join('\n');
}

/** Soak runs (V2, `npm run soak`): one row per store; absent before the first soak. */
function soakSection(k) {
  const lines = [
    '#### Soak',
    '',
    `${k.method}`,
    '',
    '| Store | Gateways | Minutes | Requests (per second) | Gateway CPU | RSS, first / last 5 min after warm-up (MB), trend | Heap after GC, same (MB), trend | Open fds idle, before / after | Metric series, end | Redis keys after | Trace hours, MB per hour | Checks passed |',
    '|---|---:|---:|---:|---:|---|---|---|---:|---:|---|---:|',
  ];
  for (const r of k.runs) {
    // Check names before and after the V2 follow-up (RSS against a control process; heap after GC plus external).
    const v = (...parts) => r.verdicts.filter((x) => parts.some((part) => x.check.endsWith(part)));
    // A row judged with the V2 follow-up criteria says so in the cell: the two kinds of rows share the columns.
    const label = (check) => (check.endsWith('beyond the control process') ? 'minus control ' : check.endsWith('plus external memory growth') ? 'plus external ' : '');
    const trend = (...parts) =>
      v(...parts)
        .map((x) => [label(x.check), /^(?:gateway minus control )?(-?[\d.]+ to -?[\d.]+) MB; trend (-?[\d.]+)%/.exec(x.measured)])
        .map(([l, m]) => (m ? `${l}${m[1]}, ${m[2]}%` : 'n/a'))
        .join('; ');
    const gws = r.perGateway;
    lines.push(
      `| ${r.mode} | ${num(r.gateways)} | ${num(r.minutes)} | ${num(r.requests)} (${num(r.answeredPerS, 1)}) | ${gws.map((g) => `${num(g.cpuPct, 1)}%`).join(', ')} | ${trend(': RSS growth', ': RSS growth beyond the control process')} | ${trend(': heap used after GC growth', ': heap after GC plus external memory growth')} | ${gws.map((g) => `${num(g.idleBefore.fds)} / ${num(g.idleAfter.fds)}`).join('; ')} | ${gws.map((g) => num(g.idleAfter.series)).join(', ')} | ${r.redis ? num(r.redis.after.keys) : 'n/a'} | ${gws.map((g) => `${num(g.traceHours)}, ${num(g.traceMbPerHourOfLoad, 1)}`).join('; ')} | ${num(r.verdicts.filter((x) => x.ok).length)} of ${num(r.verdicts.length)} |`,
    );
  }
  const failed = k.runs.flatMap((r) => r.verdicts.filter((x) => !x.ok).map((x) => `${r.mode}: ${x.check} (${x.measured}; threshold ${x.threshold})`));
  if (failed.length > 0) lines.push('', 'Failed checks:', '', ...failed.map((f) => `- ${f}`));
  lines.push('', 'Thresholds, every check and the commands: docs/benchmarks.md, "Soak".', '');
  return lines.join('\n');
}

/** The Markdown between the markers, without the markers. Deterministic: the same results give the same text. */
export function renderBenchBlock(r) {
  const tools = Object.entries(r.tools)
    .map(([k, v]) => `${k} ${v ?? 'not used'}`)
    .join(', ');
  const lines = [
    `Measured by \`npm run bench\` on ${r.hardware.cpu} (${num(r.hardware.cores)} cores, ${num(r.hardware.memoryGb)} GB, ${r.hardware.arch}), ${r.os.platform} ${r.os.release}, Node ${r.node}; ${tools}; commit \`${r.git.commit}\`${r.git.dirty ? ' with uncommitted changes' : ''}, run ${r.runAt}. Every request goes to the mock provider on loopback; no real provider is called.`,
    ...(r.quick ? ['', '**Quick run (BENCH_QUICK=1): shortened overhead runs, not for publishing.**'] : []),
    '',
    '#### SLO targets (spec 12.1)',
    '',
    '| SLI | Target | Measured | Result |',
    '|---|---|---|---|',
    ...r.slo.map((s) => `| ${s.sli} | ${s.target} | ${s.measured} | ${verdict(s.met)} |`),
    '',
    overheadSection(r.overhead),
    ...(r.overhead.workers ? [workersSection(r.overhead.workers)] : []),
    budgetSection(r.budget),
    cacheSection(r.cache),
    scanSection(r.scan),
    replaySection(r.replay),
    calibrationSection(r.calibration),
    ...(r.soak ? [soakSection(r.soak)] : []),
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function markers(readme) {
  const start = readme.indexOf(BENCH_START);
  const end = readme.indexOf(BENCH_END);
  const single = start !== -1 && readme.indexOf(BENCH_START, start + 1) === -1 && end !== -1 && readme.indexOf(BENCH_END, end + 1) === -1;
  return single && start < end ? { start, end } : null;
}

/** The README with only the text between the markers replaced. Throws unless both markers appear once, in order. */
export function writeBenchBlock(readme, results) {
  const m = markers(readme);
  if (!m) throw new Error(`the README needs one ${BENCH_START} followed by one ${BENCH_END}`);
  return `${readme.slice(0, m.start + BENCH_START.length)}\n${renderBenchBlock(results)}\n${readme.slice(m.end)}`;
}

/** True when the README holds exactly the block the results render to, from a full run (a quick run never passes). */
export function checkBenchBlock(readme, results) {
  if (results.quick || !markers(readme)) return false;
  return writeBenchBlock(readme, results) === readme;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const resultsPath = opt('--results') ?? 'bench/results.json';
  const write = opt('--write');
  const check = opt('--check');
  if (!write === !check) {
    console.error('usage: bench-to-readme.mjs (--write README.md | --check README.md) [--results bench/results.json]');
    process.exit(2);
  }
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const file = write ?? check;
  const readme = readFileSync(file, 'utf8');
  if (write) {
    writeFileSync(file, writeBenchBlock(readme, results));
    console.log(`${file}: benchmark block written from ${resultsPath}`);
  } else if (results.quick) {
    console.error(`${resultsPath} is from a quick run (BENCH_QUICK=1), which is not for publishing; run npm run bench in full`);
    process.exit(1);
  } else if (checkBenchBlock(readme, results)) {
    console.log(`${file}: benchmark block matches ${resultsPath}`);
  } else {
    console.error(`${file}: benchmark block is out of date; run npm run bench and node scripts/bench-to-readme.mjs --write ${file}`);
    process.exit(1);
  }
}
