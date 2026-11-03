// Secret scan timing (spec 12.3 item 4): time per MB for the last-turn scan and for a full-body scan of a synthetic
// coding-agent body, and block hits on the false-positive corpus. Part of `npm run bench`; alone: npx tsx bench/scan.ts [megabytes]
import { DEFAULT_RULES } from '../src/guardrails/rules.js';
import { scanBody } from '../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../src/surfaces/anthropic-messages.js';
import { corpus, scanCorpus } from '../test/helpers/fp-corpus.js';
import { round } from './lib.js';

/** A body of about `mb` MiB: source-like text in tool results, history first, the newest turn last. */
export function syntheticBody(mb: number): Buffer {
  const chunk = 'export function add(a: number, b: number): number {\n  return a + b; // token count, secret santa, api docs\n}\n'.repeat(64);
  const messages: unknown[] = [];
  let size = 0;
  for (let i = 0; size < mb * 1024 * 1024; i++) {
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: chunk }] }, { role: 'assistant', content: 'ok' });
    size += chunk.length + 80;
  }
  messages.push({ role: 'user', content: 'continue' });
  return Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1024, messages }));
}

/** Milliseconds per MiB, median of `runs`, for the default rules with every rule on block. */
export function benchScan(body: Buffer, mode: 'last-turn' | 'full', runs = 5): number {
  const f = extractAnthropicFeatures(body);
  const lastTurn = mode === 'full' ? { start: 0, end: body.length } : f.lastTurn;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    scanBody(body, lastTurn, DEFAULT_RULES, () => 'block', 'bench');
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return (times[Math.floor(runs / 2)] ?? 0) / (body.length / 1024 / 1024);
}

export interface ScanResult {
  bodyMb: number;
  /** MiB of request body handled per second when only the newest turn is scanned (what the gateway does per request). */
  lastTurnMbPerS: number;
  fullBodyMbPerS: number;
  fpCorpus: { files: number; mb: number; blockHits: number; documentedExamples: number };
}

export function benchScanAll(mb = 4): ScanResult {
  const body = syntheticBody(mb);
  const perS = (msPerMiB: number): number => round(1000 / msPerMiB, 1);
  benchScan(body, 'full', 2); // warm-up
  const fp = scanCorpus(corpus());
  return {
    bodyMb: round(body.length / 1024 / 1024, 2),
    lastTurnMbPerS: perS(benchScan(body, 'last-turn', 9)),
    fullBodyMbPerS: perS(benchScan(body, 'full', 9)),
    fpCorpus: { files: fp.files, mb: round(fp.bytes / 1024 / 1024, 1), blockHits: fp.offenders.length, documentedExamples: fp.examples },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const body = syntheticBody(Number(process.argv[2] ?? 4));
  for (const mode of ['last-turn', 'full'] as const) console.log(`${mode}: ${benchScan(body, mode).toFixed(2)} ms/MiB over ${(body.length / 1024 / 1024).toFixed(1)} MiB`);
}
