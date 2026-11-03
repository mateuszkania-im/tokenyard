// Spec 13 "Data shown in the README": aggregates of the anonymized live export (examples/live/live.ndjson.gz, written by
// `tokenyard traces export --anonymize`) for the README's Real sessions section. Reads only the anonymized export and
// the committed live price table; writes examples/live/summary.json. Claude Code's own per-session cost figures are not
// in any trace, so they are copied from the live run log (test/live/claude-code.live.md) and labelled as such.
//
// With the raw live traces present (.live/traces, local and gitignored), it also writes .live/raw-names.json: the raw
// tenant, team, key, repo, branch, ticket and feature values, which test/docs/readme.test.ts checks never
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
 * Claude Code's own `total_cost_usd` per session, as printed by `claude -p`, from test/live/claude-code.live.md (run 1,
 * 2026-11-02). Sessions are numbered in the order they started, as in that log.
 */
const CLAUDE_CODE_REPORTED = [0.1713382, 0.09903, 0.158844, 0.0746165, 0.0123766];
/** Client versions are dropped by --anonymize; these are the versions the live logs name. */
const CLIENTS = [
  { agent: 'claude-code', version: '2.1.316', log: 'test/live/claude-code.live.md' },
  { agent: 'codex', version: '0.166.0', log: 'test/live/codex.live.md' },
];

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
  const refusedGroups = new Map<string, { what: string; model: string; boundKind: string; requests: number; reservationUsd: number | null }>();
  for (const r of rs.filter((x) => x.decision.action === 'block' && x.decision.reason === 'budget')) {
    const what = r.features.serverTools.length > 0 ? `server tools ${r.features.serverTools.map((t) => `${t.type} (max_uses ${t.maxUses})`).join(', ')}` : 'no server tools';
    const k = `${what}|${r.features.model}|${r.features.boundKind}`;
    const g = refusedGroups.get(k);
    const micro = worstCase(r, table);
    if (g) g.requests++;
    else refusedGroups.set(k, { what, model: r.features.model, boundKind: r.features.boundKind, requests: 1, reservationUsd: micro === null ? null : usd(micro) });
  }

  const codex = rs.filter((r) => r.client.agent === 'codex');
  const summary = {
    source: 'examples/live/live.ndjson.gz: tokenyard traces export --anonymize of the local live runs (spec 14.1); aggregates by bench/live-summary.ts',
    priceTable: `test/live/prices.yaml, version ${table.version}`,
    clients: CLIENTS.map((c) => ({ ...c, days: [...new Set(rs.filter((r) => r.client.agent === c.agent).map((r) => r.ts.slice(0, 10)))] })),
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
    refusedByBudget: [...refusedGroups.values()],
  };
  writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${SUMMARY}: ${rs.length} records`);

  if (existsSync(RAW_DIR)) {
    const files = readdirSync(RAW_DIR, { recursive: true, encoding: 'utf8' })
      .map((f) => join(RAW_DIR, f))
      .filter((f) => f.endsWith('.ndjson') && statSync(f).isFile());
    const names = new Map<string, string>();
    for (const r of await requests(files)) {
      const a = r.attribution;
      const fields: Array<[string, string | null]> = [
        ['tenant', r.tenant], ['team', r.team], ['key', r.keyId], ['repo', a.repo], ['branch', a.branch],
        ['ticket', a.ticket], ['feature', a.feature],
      ];
      for (const [kind, v] of fields) if (v !== null && !names.has(v)) names.set(v, kind);
    }
    writeFileSync(RAW_NAMES, `${JSON.stringify({ names: [...names].map(([value, kind]) => ({ kind, value })) }, null, 2)}\n`, { mode: 0o600 });
    console.log(`wrote ${RAW_NAMES}: ${names.size} names (local only)`);
  }
}

await main();
