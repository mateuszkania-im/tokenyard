// Spec 12.3 item 3: cache economics. The 40-turn session of conformance test C15 sent straight to the mock, through
// tokenyard and through the naive proxy (which flattens `system` and so drops its cache breakpoint), each priced at
// Opus 5.5 list prices from examples/policy/prices.yaml.
import { costMicroUsd } from '../src/pricing/cost.js';
import type { Usage } from '../src/stream/anthropic-usage.js';
import { runSession, startStack } from '../test/helpers/conformance.js';
import { startNaiveProxy } from '../test/helpers/naive-proxy.js';
import { loadPrices } from '../test/helpers/prices.js';

export interface CacheRow {
  path: 'direct' | 'tokenyard' | 'naive proxy';
  costUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache reads over all input tokens (input, cache reads and cache writes). */
  cacheHitRatio: number;
}

const MODEL = 'claude-opus-5-5';

function row(path: CacheRow['path'], usage: Usage[]): CacheRow {
  const prices = loadPrices();
  const sum = (f: (u: Usage) => number): number => usage.reduce((n, u) => n + f(u), 0);
  const input = sum((u) => u.input);
  const read = sum((u) => u.cacheRead);
  const write = sum((u) => u.cacheWrite5m + u.cacheWrite1h);
  return {
    path,
    costUsd: sum((u) => costMicroUsd(prices, MODEL, u)) / 1e6,
    inputTokens: input,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    cacheHitRatio: read / (input + read + write),
  };
}

/** Why the naive proxy row is not much more expensive on this fixture (it is about the fixture, not a general result). */
export const NAIVE_NOTE =
  'The naive proxy flattens `system` into a string, which drops the cache breakpoint on the system block. This session also marks the newest user block, and that breakpoint caches the whole prefix, the flattened system text included, so through the naive proxy the session still reads almost the same prefix from cache and costs about the same; its usage still differs from the direct run (conformance test C15b fails on it).';

export async function benchCache(): Promise<{ turns: number; model: string; note: string; rows: CacheRow[] }> {
  const stack = await startStack();
  const naive = await startNaiveProxy(stack.mock.url);
  try {
    // Each path in its own mock workspace, so no path warms the cache of another.
    const direct = await runSession(stack.mock.url, 'bench-direct');
    const via = await runSession(stack.gw.url, 'bench-tokenyard');
    const naiveUsage = await runSession(naive.url, 'bench-naive');
    return { turns: direct.length, model: MODEL, note: NAIVE_NOTE, rows: [row('direct', direct), row('tokenyard', via), row('naive proxy', naiveUsage)] };
  } finally {
    await naive.close();
    await stack.close();
  }
}
