// Spec 13 "Data shown in the README": aggregates of the anonymized live export (examples/live/live.ndjson.gz, written by
// `tokenyard traces export --anonymize`) for the README's Real sessions section. Reads only the anonymized export and
// the committed live price table; writes examples/live/summary.json. Claude Code's own per-session cost figures are not
// in any trace, so they are copied from the live run log (test/live/claude-code.live.md) and labelled as such.
//
// With the raw live traces present (.live/traces, local and gitignored), it also writes .live/raw-names.json: the raw
// tenant, team, key, repo, branch, ticket and feature values and every linkable id, which test/docs/readme.test.ts checks never
// appear in examples/live. That file never leaves .live/.
//   npx tsx bench/live-summary.ts
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceRecord } from '../src/ledger/record.js';
import { readLedger } from '../src/ledger/reader.js';
import { worstCaseMicroUsd } from '../src/limits/estimator.js';
import type { RequestFeatures } from '../src/policy/types.js';
import { lookupModel, parsePriceTable, type PriceTable } from '../src/pricing/prices.js';
import { ROOT, round } from './lib.js';

const EXPORT = join(ROOT, 'examples', 'live', 'live.ndjson.gz');
const SUMMARY = join(ROOT, 'examples', 'live', 'summary.json');
const PRICES = join(ROOT, 'test', 'live', 'prices.yaml');
const RAW_DIR = join(ROOT, '.live', 'traces');
const RAW_NAMES = join(ROOT, '.live', 'raw-names.json');

/**
 * Claude Code's own `total_cost_usd` per session, as printed by `claude -p` (for a resumed session, the figure printed
 * after its last turn), from test/live/claude-code.live.md: run 1 (2026-11-02) sessions 1 to 5, run 2 (2026-11-03)
 * sessions 6 to 11. Sessions are numbered in the order they started, as in that log. Session 10 was refused at its
 * first request and printed 0.
 */
const CLAUDE_CODE_REPORTED = [0.1713382, 0.09903, 0.158844, 0.0746165, 0.0123766, 0.002156575, 0.012180325, 0.1019788, 0.010197095, 0, 0.002589415];
/**
 * The live cap of each harness start that served a request other than Codex's, in start order:
 * `TOKENYARD_LIVE_BUDGET_USD` set from the shell for each start (test/live/claude-code.live.md: run 1 lowered it to 3,
 * then 5, then 8 to keep the runs small; run 2 started at 8.53, the most that run could take, then at the spent amount
 * plus about 3 and 8 cents for the budget block checks). The budget is cumulative: each start seeds the spend of the
 * earlier runs. The Codex-only starts of run 1 ran under 3.5 (test/live/codex.live.md).
 */
const CLAUDE_CODE_RUN_CAPS_USD = [3, 5, 8, 8.53, 0.704842, 0.754842];
const CODEX_RUN_CAP_USD = 3.5;
/** Client versions are dropped by --anonymize; these are the versions the live logs name, per run. */
const RUNS = [
  { run: 1, from: '2026-11-02T00:00:00.000Z', until: '2026-11-03T12:00:00.000Z', clients: { 'claude-code': '2.1.316', codex: '0.166.0' } },
  { run: 2, from: '2026-11-03T12:00:00.000Z', until: '2026-11-17T00:00:00.000Z', clients: { 'claude-code': '2.1.317', codex: '0.166.0' } },
] as const;
const CLIENTS = [
  { agent: 'claude-code', log: 'test/live/claude-code.live.md' },
  { agent: 'codex', log: 'test/live/codex.live.md' },
] as const;
/**
 * Run 2 measurements that no trace holds, copied from test/live/claude-code.live.md (run 2) and labelled as such:
 * Claude Code's own OTel `api_request` events joined to the trace records, and the same scripted session sent once
 * through the gateway and once direct (the direct run is outside the gateway, so its spend is listed separately).
 */
const RUN2_FROM_LOG = {
  source: 'test/live/claude-code.live.md, run 2 (copied from the log; no trace holds OTel events or the direct run)',
  otel: {
    apiRequestEvents: 42,
    joined: 42,
    otelCostUsd: 0.12910221,
    tokenyardCostUsd: 0.129104,
    deltaMicroUsd: 1.79,
    deltaPct: 0.00139,
    maxPerRequestDeltaMicroUsd: 0.495,
  },
  cacheBaseline: {
    what: 'the same 5-turn scripted Messages session on Haiku 5.5, a 13,500-token cached system block, each run with its own nonce so both start cold',
    gatewayCacheReadShare: 0.7994087,
    directCacheReadShare: 0.7994088,
    directSpendUsd: 0.002236,
  },
};

const usd = (micro: number): number => round(micro / 1_000_000, 6);

async function requests(paths: string[]): Promise<TraceRecord[]> {
  const out: TraceRecord[] = [];
  for await (const l of readLedger(paths)) if (l.kind === 'request') out.push(l);
  return out;
}

/** Prompt tokens billed (Responses cache writes are on top of input, as the gateway's R11 check counts them). */
const billedInput = (r: TraceRecord): number => {
  const u = r.outcome.usage;
  if (!u) return 0;
  return u.input + u.cacheRead + (r.surface === 'openai-responses' ? 0 : u.cacheWrite5m + u.cacheWrite1h);
};
const billed = (r: TraceRecord): boolean => r.outcome.usage !== null && (r.outcome.costMicroUsd ?? 0) > 0;

/** Cache read tokens over all prompt tokens (input, cache read, cache write) of billed requests. */
function cacheHitRatio(rs: readonly TraceRecord[]): number | null {
  let read = 0;
  let all = 0;
  for (const r of rs.filter(billed)) {
    const u = r.outcome.usage;
    if (!u) continue;
    read += u.cacheRead;
    all += u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  }
  return all === 0 ? null : round(read / all, 4);
}

/** What the worst-case estimator reserves for a recorded request (blocked records carry 0), from its traced features. */
function worstCase(r: TraceRecord, t: PriceTable): number | null {
  const found = lookupModel(t, r.features.model);
  if (!found) return null;
  const f = {
    surface: r.surface as RequestFeatures['surface'],
    model: r.features.model,
    inputTokensBound: r.features.inputTokensBound,
    boundKind: r.features.boundKind,
    maxOutputTokens: r.features.maxOutputTokens,
    serverTools: r.features.serverTools,
    fastMode: false,
  } as RequestFeatures;
  return worstCaseMicroUsd(f, found.price, t, { serverToolsWithoutMaxUses: 'block', assumedMaxUses: 0, reserveOutputTokens: null }).micro;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const days = (rs: readonly TraceRecord[]): string[] => [...new Set(rs.map((r) => r.ts.slice(0, 10)))].sort();
/** The run (RUNS) a record belongs to, by its time. */
const runOf = (r: TraceRecord): number | null => RUNS.find((x) => r.ts >= x.from && r.ts < x.until)?.run ?? null;

async function main(): Promise<void> {
  const rs = await requests([EXPORT]);
  const table = parsePriceTable(readFileSync(PRICES, 'utf8'));
  const cc = rs.filter((r) => r.client.agent === 'claude-code');

  // Claude Code sessions in start order, numbered as in the live log.
  const sessionIds = [...new Set(cc.map((r) => r.attribution.session).filter((s): s is string => s !== null))];
  const sessions = sessionIds.map((id, i) => {
    const s = cc.filter((r) => r.attribution.session === id);
    const b = s.filter(billed);
    const cost = sum(b.map((r) => r.outcome.costMicroUsd ?? 0));
    return {
      session: i + 1,
      run: runOf(s[0] as TraceRecord),
      models: [...new Set(s.map((r) => r.features.model))],
      requests: s.length,
      billed: b.length,
      blocked: s.filter((r) => r.decision.action === 'block').length,
      mainTurns: b.filter((r) => r.attribution.requestClass === 'main').length,
      subagentTurns: b.filter((r) => r.attribution.requestClass === 'subagent').length,
      tokenyardCostUsd: usd(cost),
      claudeCodeReportedCostUsd: CLAUDE_CODE_REPORTED[i] ?? null,
      cacheHitRatio: cacheHitRatio(s),
    };
  });

  const bytesBilled = rs.filter((r) => billed(r) && r.features.boundKind === 'bytes');
  const actualToBound = bytesBilled.map((r) => billedInput(r) / r.features.inputTokensBound);

  // Admitted reservations by model and bound kind.
  const groups = new Map<string, number[]>();
  for (const r of rs.filter((x) => x.decision.action === 'forward')) {
    const k = `${r.features.model}|${r.features.boundKind}`;
    groups.set(k, [...(groups.get(k) ?? []), r.decision.reservedMicroUsd]);
  }
  const reservations = [...groups].map(([k, xs]) => {
    const [model, boundKind] = k.split('|');
    return { model, boundKind, admitted: xs.length, minUsd: usd(Math.min(...xs)), maxUsd: usd(Math.max(...xs)) };
  });

  // Requests refused because their worst-case reservation was larger than the live cap allowed.
  // Harness starts are the export's instances (one per start), in start order; Claude Code starts get their caps.
  const firstTs = new Map<string, string>();
  for (const r of rs) if (!firstTs.has(r.instance) || (firstTs.get(r.instance) as string) > r.ts) firstTs.set(r.instance, r.ts);
  const starts = [...firstTs].sort((x, y) => (x[1] < y[1] ? -1 : 1)).map(([id]) => id);
  const ccStarts = starts.filter((id) => rs.some((r) => r.instance === id && r.client.agent !== 'codex'));
  const capOf = (instance: string): number | null => {
    const i = ccStarts.indexOf(instance);
    if (i >= 0) return CLAUDE_CODE_RUN_CAPS_USD[i] ?? null;
    return rs.some((r) => r.instance === instance && r.client.agent === 'codex') ? CODEX_RUN_CAP_USD : null;
  };
  // Spend already charged when a request arrived: every earlier charge in the export (the cap is cumulative).
  const spentBefore = (r: TraceRecord): number => sum(rs.filter((x) => x.ts < r.ts).map((x) => x.outcome.chargedMicroUsd ?? 0));

  const refusedGroups = new Map<string, { what: string; client: string; model: string; maxOutputTokens: number | null; boundKind: string; requests: number; reservationUsd: number | null; runCapUsd: number | null; spentBeforeUsd: { min: number; max: number } }>();
  for (const r of rs.filter((x) => x.decision.action === 'block' && x.decision.reason === 'budget')) {
    const what = r.features.serverTools.length > 0 ? `server tools ${r.features.serverTools.map((t) => `${t.type} (max_uses ${t.maxUses})`).join(', ')}` : 'no server tools';
    const cap = capOf(r.instance);
    const k = `${what}|${r.client.agent}|${r.features.model}|${r.features.boundKind}|${r.features.maxOutputTokens}|${cap}`;
    const g = refusedGroups.get(k);
    const micro = worstCase(r, table);
    const spent = usd(spentBefore(r));
    if (g) {
      g.requests++;
      g.spentBeforeUsd = { min: Math.min(g.spentBeforeUsd.min, spent), max: Math.max(g.spentBeforeUsd.max, spent) };
    } else {
      refusedGroups.set(k, { what, client: r.client.agent, model: r.features.model, maxOutputTokens: r.features.maxOutputTokens, boundKind: r.features.boundKind, requests: 1, reservationUsd: micro === null ? null : usd(micro), runCapUsd: cap, spentBeforeUsd: { min: spent, max: spent } });
    }
  }

  // Each harness start: its cap, the spend it seeded from earlier starts and the spend when it stopped; the cap is
  // enforced by tokenyard, so the spend at the end is never above the cap.
  const startRows = starts.map((id, i) => {
    const before = sum(rs.filter((r) => starts.indexOf(r.instance) < i).map((r) => r.outcome.chargedMicroUsd ?? 0));
    const own = rs.filter((r) => r.instance === id);
    const after = before + sum(own.map((r) => r.outcome.chargedMicroUsd ?? 0));
    const cap = capOf(id);
    return {
      start: i + 1,
      run: runOf(own[0] as TraceRecord),
      capUsd: cap,
      spentAtStartUsd: usd(before),
      spentAtEndUsd: usd(after),
      withinCap: cap === null ? null : after <= Math.round(cap * 1_000_000),
      requests: own.length,
      refusedByBudget: own.filter((r) => r.decision.action === 'block' && r.decision.reason === 'budget').length,
    };
  });
  const runs = RUNS.map((run) => {
    const xs = rs.filter((r) => runOf(r) === run.run);
    const ccRun = xs.filter((r) => r.client.agent === 'claude-code');
    return {
      run: run.run,
      days: days(xs),
      records: xs.length,
      billed: xs.filter(billed).length,
      spendUsd: usd(sum(xs.map((r) => r.outcome.chargedMicroUsd ?? 0))),
      claudeCodeSessions: sessions.filter((x) => x.run === run.run).map((x) => x.session),
      claudeCodeBilled: ccRun.filter(billed).length,
      claudeCodeCostUsd: usd(sum(ccRun.map((r) => r.outcome.costMicroUsd ?? 0))),
      codexCostUsd: usd(sum(xs.filter((r) => r.client.agent === 'codex').map((r) => r.outcome.costMicroUsd ?? 0))),
      claudeCodeCacheHitRatio: cacheHitRatio(ccRun),
      codexBilled: xs.filter((r) => r.client.agent === 'codex' && billed(r)).length,
      codexCacheHitRatio: cacheHitRatio(xs.filter((r) => r.client.agent === 'codex')),
      requestClasses: Object.fromEntries(
        [...new Set(ccRun.filter(billed).map((r) => r.attribution.requestClass))].sort().map((c) => [c, ccRun.filter((r) => billed(r) && r.attribution.requestClass === c).length]),
      ),
    };
  });

  const codex = rs.filter((r) => r.client.agent === 'codex');
  const summary = {
    source: 'examples/live/live.ndjson.gz: tokenyard traces export --anonymize of the local live runs (spec 14.1); aggregates by bench/live-summary.ts',
    priceTable: `test/live/prices.yaml, version ${table.version}`,
    dates: 'UTC',
    clients: RUNS.flatMap((run) =>
      CLIENTS.map((c) => ({ ...c, run: run.run, version: run.clients[c.agent], days: days(rs.filter((r) => r.client.agent === c.agent && runOf(r) === run.run)) })),
    ).filter((c) => c.days.length > 0),
    runs,
    starts: startRows,
    records: rs.length,
    forwarded: rs.filter((r) => r.decision.action === 'forward').length,
    blocked: rs.filter((r) => r.decision.action === 'block').length,
    blockedBy: Object.fromEntries(
      [...new Set(rs.filter((r) => r.decision.action === 'block').map((r) => r.decision.reason ?? 'none'))].map((reason) => [
        reason,
        rs.filter((r) => r.decision.action === 'block' && (r.decision.reason ?? 'none') === reason).length,
      ]),
    ),
    billed: rs.filter(billed).length,
    spendUsd: usd(sum(rs.map((r) => r.outcome.chargedMicroUsd ?? r.outcome.costMicroUsd ?? 0))),
    overruns: rs.filter((r) => r.outcome.overrun).length,
    settledBySweeper: rs.filter((r) => billed(r) && r.outcome.settledBy !== 'request').length,
    claudeCode: {
      requests: cc.length,
      billed: cc.filter(billed).length,
      costUsd: usd(sum(cc.map((r) => r.outcome.costMicroUsd ?? 0))),
      claudeCodeReportedCostUsd: round(sum(CLAUDE_CODE_REPORTED), 7),
      claudeCodeReportedSource: 'test/live/claude-code.live.md (claude -p total_cost_usd per session)',
      cacheHitRatio: cacheHitRatio(cc),
      sessions,
    },
    codex: {
      requests: codex.length,
      billed: codex.filter(billed).length,
      blocked: codex.filter((r) => r.decision.action === 'block').length,
      costUsd: usd(sum(codex.map((r) => r.outcome.costMicroUsd ?? 0))),
      cacheHitRatio: cacheHitRatio(codex),
    },
    otherClients: { requests: rs.filter((r) => r.client.agent === 'other').length, billed: rs.filter((r) => r.client.agent === 'other' && billed(r)).length },
    r11: {
      billed: rs.filter(billed).length,
      violations: rs.filter((r) => billed(r) && billedInput(r) > r.features.inputTokensBound).length,
      bytesBound: bytesBilled.length,
      contextWindowBound: rs.filter(billed).length - bytesBilled.length,
      actualToBytesBound: actualToBound.length === 0 ? null : { min: round(Math.min(...actualToBound), 3), max: round(Math.max(...actualToBound), 3) },
    },
    reservations,
    runCapsUsd: {
      claudeCode: CLAUDE_CODE_RUN_CAPS_USD,
      codex: CODEX_RUN_CAP_USD,
      source: 'test/live/claude-code.live.md and test/live/codex.live.md: TOKENYARD_LIVE_BUDGET_USD of each harness start, lowered from the shell; the cap is cumulative over all live runs',
    },
    refusedByBudget: [...refusedGroups.values()],
    run2FromLog: RUN2_FROM_LOG,
    refusedByBudgetNote: 'reservationUsd is what the worst-case estimator computes from the traced features with the price table above (refused records carry no reservation); a request is refused when its reservation is larger than the run cap in total, or larger than the cap minus spent and reserved',
  };
  writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${SUMMARY}: ${rs.length} records`);

  if (existsSync(RAW_DIR)) {
    const files = readdirSync(RAW_DIR, { recursive: true, encoding: 'utf8' })
      .map((f) => join(RAW_DIR, f))
      .filter((f) => f.endsWith('.ndjson') && statSync(f).isFile());
    const names = new Map<string, string>();
    // Linkable ids of the raw traces (record, instance, session, agent and prompt ids, prefix hashes, guardrail value
    // HMACs): an anonymized export must contain none of them.
    const ids = new Set<string>();
    for (const r of await requests(files)) {
      const a0 = r.attribution;
      for (const v of [r.id, r.instance, a0.session, a0.agent, a0.parentAgent, a0.promptId, r.features.prefixHash, ...r.guardrail.hits.map((h) => h.valueHmac)]) {
        if (v) ids.add(v);
      }
      const a = r.attribution;
      const fields: Array<[string, string | null]> = [
        ['tenant', r.tenant], ['team', r.team], ['key', r.keyId], ['repo', a.repo], ['branch', a.branch],
        ['ticket', a.ticket], ['feature', a.feature],
      ];
      for (const [kind, v] of fields) if (v !== null && !names.has(v)) names.set(v, kind);
    }
    writeFileSync(RAW_NAMES, `${JSON.stringify({ names: [...names].map(([value, kind]) => ({ kind, value })), ids: [...ids] }, null, 2)}\n`, { mode: 0o600 });
    console.log(`wrote ${RAW_NAMES}: ${names.size} names and ${ids.size} ids (local only)`);
  }
}

await main();
