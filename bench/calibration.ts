// Spec 12.3 item 6 and R11: estimator calibration. For every request with usage, the input token bound it was admitted
// with against the input the provider billed, and its reservation against its actual cost; on the committed demo
// traces and on the local live traces (.live/traces, real Claude Code and Codex runs, gitignored). Only aggregates
// leave this file. Any request whose billed input is above its bound fails the run (exit 1).
//   npx tsx bench/calibration.ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TraceRecord } from '../src/ledger/record.js';
import { readLedger } from '../src/ledger/reader.js';
import { ROOT, percentile, round } from './lib.js';
import { DEMO_TRACES } from './replay.js';

export const LIVE_DIR = join(ROOT, '.live', 'traces');

interface Range {
  min: number;
  median: number;
  max: number;
}

export interface CalibrationSource {
  source: string;
  label: string;
  requests: number;
  boundKinds: { bytes: number; 'context-window': number };
  /** inputTokensBound over billed input, bytes bounds only (a context-window bound is the model's whole window). */
  boundToActual: Range | null;
  reservationToCost: Range | null;
  violations: number;
}

/** Prompt tokens billed, counted the way the gateway's R11 check counts them (Responses cache writes are on top of input). */
export const billedInput = (r: TraceRecord): number => {
  const u = r.outcome.usage;
  if (!u) return 0;
  return u.input + u.cacheRead + (r.surface === 'openai-responses' ? 0 : u.cacheWrite5m + u.cacheWrite1h);
};

function range(xs: number[]): Range | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { min: round(s[0] as number), median: round(percentile(s, 50)), max: round(s.at(-1) as number) };
}

export function calibrate(source: string, label: string, records: readonly TraceRecord[]): CalibrationSource {
  const withUsage = records.filter((r) => r.outcome.usage !== null && billedInput(r) > 0);
  const bytes = withUsage.filter((r) => r.features.boundKind === 'bytes');
  const priced = withUsage.filter((r) => r.decision.reservedMicroUsd > 0 && (r.outcome.costMicroUsd ?? 0) > 0);
  return {
    source,
    label,
    requests: withUsage.length,
    boundKinds: { bytes: bytes.length, 'context-window': withUsage.length - bytes.length },
    boundToActual: range(bytes.map((r) => r.features.inputTokensBound / billedInput(r))),
    reservationToCost: range(priced.map((r) => r.decision.reservedMicroUsd / (r.outcome.costMicroUsd as number))),
    violations: withUsage.filter((r) => billedInput(r) > r.features.inputTokensBound).length,
  };
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => join(dir, f))
    .filter((f) => /\.ndjson(\.gz)?$/.test(f) && statSync(f).isFile())
    .sort();
}

async function requests(paths: string[]): Promise<TraceRecord[]> {
  const out: TraceRecord[] = [];
  for await (const l of readLedger(paths)) if (l.kind === 'request') out.push(l);
  return out;
}

const versions = (rs: readonly TraceRecord[]): string => [...new Set(rs.map((r) => r.client.version).filter((v): v is string => v !== null))].sort().join(', ');
const days = (rs: readonly TraceRecord[]): string => [...new Set(rs.map((r) => r.ts.slice(0, 10)))].sort().join(', ');

export async function benchCalibration(): Promise<{ violations: number; sources: CalibrationSource[]; note: string }> {
  const sources = [calibrate('demo', 'Demo traffic (mock provider, 4 bytes per token)', await requests([DEMO_TRACES]))];
  const live = await requests(files(LIVE_DIR));
  let note = 'Live rows come from the local live runs through tokenyard (spec 14.1) and are aggregates only.';
  if (live.length === 0) note = 'Live traces were not available on this run (.live/traces is local and gitignored), so live calibration is not measured here.';
  for (const [agent, name] of [
    ['claude-code', 'Claude Code'],
    ['codex', 'Codex'],
  ] as const) {
    const rs = live.filter((r) => r.client.agent === agent);
    if (rs.length > 0) sources.push(calibrate(`live-${agent}`, `Live ${name} ${versions(rs)}, ${days(rs)}`, rs));
  }
  return { violations: sources.reduce((n, s) => n + s.violations, 0), sources, note };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const c = await benchCalibration();
  console.log(JSON.stringify(c, null, 2));
  if (c.violations > 0) {
    console.error(`calibration: ${c.violations} request(s) billed more input than their bound (R11)`);
    process.exit(1);
  }
}
