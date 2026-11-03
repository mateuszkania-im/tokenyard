// Per-request CPU of the gateway's synchronous steps on the overhead benchmark's 150 KB body (V1 profiling): feature
// extraction, the body-shape check, the guardrail scan (newest turn with every rule, history with the block rules, as
// examples/policy runs coding-agent keys) and one breaker outcome with a full 30 s window at 2,500 requests a second.
// Not part of `npm run bench`; alone: npx tsx bench/hot-path.ts [iterations]
import { DEFAULT_RULES } from '../src/guardrails/rules.js';
import { scanBody } from '../src/guardrails/scan.js';
import { bodyShapeRefusal } from '../src/surfaces/body-shape.js';
import { extractAnthropicFeatures } from '../src/surfaces/anthropic-messages.js';
import { Breaker } from '../src/upstream/breaker.js';
import { round } from './lib.js';
import { scenarioBody } from './overhead.js';

/** Median milliseconds per call over `runs` batches of `n` calls, after a warm-up batch. */
function perCall(fn: () => unknown, n: number, runs = 7): number {
  for (let i = 0; i < n; i++) fn();
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    times.push((performance.now() - t0) / n);
  }
  times.sort((a, b) => a - b);
  return round(times[Math.floor(runs / 2)] ?? 0, 4);
}

export function benchHotPath(n = 200): Record<string, number> {
  const body = scenarioBody('body-150kb');
  const f = extractAnthropicFeatures(body);
  const messages = f.messages ?? [];
  let t = 0;
  const breaker = new Breaker({ minRequests: 20, failureRatio: 0.5, windowSeconds: 30, openSeconds: 30 }, () => t);
  for (let i = 0; i < 75_000; i++) {
    t += 0.4;
    breaker.record('mock', true);
  }
  return {
    bodyBytes: body.length,
    jsonParseMs: perCall(() => JSON.parse(body.toString('utf8')), n),
    extractFeaturesMs: perCall(() => extractAnthropicFeatures(body), n),
    bodyShapeMs: perCall(() => bodyShapeRefusal(body, true), n),
    guardrailScanMs: perCall(() => scanBody(body, f.lastTurn, DEFAULT_RULES, () => 'block', 'salt', { messages }), n),
    breakerRecordMs: perCall(() => {
      t += 0.4;
      breaker.record('mock', true);
    }, n * 10),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [k, v] of Object.entries(benchHotPath(Number(process.argv[2] ?? 200)))) console.log(`${k.padEnd(18)} ${v}`);
}
