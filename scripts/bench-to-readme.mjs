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
const ratio = (r) => (r ? `${num(r.min, 2)} / ${num(r.median, 2)} / ${num(r.max, 2)}` : 'n/a');
const verdict = (met) => (met === true ? 'met' : met === false ? 'missed' : 'not measured');
const SCENARIOS = { 'non-streaming': 'Non-streaming, small body', 'streaming-500': 'Streaming, 500 tokens', 'body-150kb': 'Streaming, 150 KB body' };

function overheadTable(rows) {
  const out = [
    '| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms) | Added total p50 / p95 / p99 (ms) | Gateway CPU per 100 streams | Gateway RSS per 100 streams | Errors (direct / gateway) |',
    '|---|---:|---|---|---:|---:|---:|',
  ];
  for (const r of rows) {
    out.push(
      `| ${SCENARIOS[r.scenario] ?? r.scenario} | ${num(r.concurrency)} | ${triple(r.added.ttfb)} | ${triple(r.added.total)} | ${num(r.cpuPctPer100Streams, 1)}% | ${num(r.rssMbPer100Streams, 1)} MB | ${num(r.errors.direct)} / ${num(r.errors.gateway)} |`,
    );
  }
  return out.join('\n');
}

function overheadSection(o) {
  const main = [10, 100, 500];
  const lines = ['#### Gateway overhead', '', `${o.method}`, ''];
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
  if (o.rows.some((r) => !main.includes(r.concurrency))) {
    lines.push('<details><summary>Every concurrency level, with absolute latencies</summary>', '');
    lines.push(
      '| Store | Scenario | Streams | Rate per stream (req/s) | Requests (direct / gateway) | Direct TTFB p50 / p95 / p99 (ms) | Gateway TTFB p50 / p95 / p99 (ms) | Direct total p50 / p95 / p99 (ms) | Gateway total p50 / p95 / p99 (ms) | Gateway CPU | Gateway RSS |',
      '|---|---|---:|---:|---:|---|---|---|---|---:|---:|',
    );
    for (const r of o.rows) {
      lines.push(
        `| ${r.store} | ${SCENARIOS[r.scenario] ?? r.scenario} | ${num(r.concurrency)} | ${num(r.ratePerConnection, 2)} | ${num(r.requests.direct)} / ${num(r.requests.gateway)} | ${triple(r.direct.ttfb)} | ${triple(r.gateway.ttfb)} | ${triple(r.direct.total)} | ${triple(r.gateway.total)} | ${num(r.gatewayCpuPct, 1)}% | ${num(r.gatewayRssMb, 1)} MB |`,
      );
    }
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

function budgetSection(b) {
  const lines = [
    '#### Budget correctness',
    '',
    'The G4 proof scenario of spec 7.4: concurrent requests through the gateway against one enforced budget, each with an actual cost drawn (seeded) between 0 and its limits.',
    '',
    '| Store | Estimator | Budget | Concurrent requests | Admitted | Rejected | Final spend | Max spent + reserved after any admit | Max overspend | Final spend minus settled costs | Reserved left |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of b.runs) {
    lines.push(
      `| ${r.store} | ${r.estimator} | ${usd(r.limitUsd)} | ${num(r.requests)} | ${num(r.admitted)} | ${num(r.rejected)} | ${usd(r.finalSpentUsd, 6)} | ${usd(r.maxSpentPlusReservedUsd, 6)} | ${usd(r.maxOverspendUsd, 6)} | ${num(r.spendDriftMicroUsd)} micro-USD | ${num(r.reservedLeftMicroUsd)} micro-USD |`,
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
    budgetSection(r.budget),
    cacheSection(r.cache),
    scanSection(r.scan),
    replaySection(r.replay),
    calibrationSection(r.calibration),
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

/** True when the README holds exactly the block the results render to. */
export function checkBenchBlock(readme, results) {
  if (!markers(readme)) return false;
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
  } else if (checkBenchBlock(readme, results)) {
    console.log(`${file}: benchmark block matches ${resultsPath}`);
  } else {
    console.error(`${file}: benchmark block is out of date; run npm run bench and node scripts/bench-to-readme.mjs --write ${file}`);
    process.exit(1);
  }
}
