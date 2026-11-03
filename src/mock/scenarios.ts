export interface ReceivedRequest {
  method: string;
  pathAndQuery: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export type Scenario =
  | { kind: 'ok'; ttftMs: number; tokensPerSec: number; pingEveryMs: number | null; outputTokens: number }
  | { kind: 'midStreamError'; afterEvents: number; errorType: string }
  | { kind: 'status'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'drop'; afterEvents: number }
  | { kind: 'hangBeforeHeaders' }
  | { kind: 'pauseAfterStart'; pauseMs: number }
  | { kind: 'randomUsage'; seed: number };

/**
 * Records a request, keeping at most `max` (the newest): a long-running mock must not keep every body it was sent
 * (V2). Tests read `received` and leave `max` unset; `tokenyard mock` keeps none.
 */
export function record(received: ReceivedRequest[], rec: ReceivedRequest, max = Number.POSITIVE_INFINITY): void {
  if (max <= 0) return;
  received.push(rec);
  if (received.length > max) received.splice(0, received.length - max);
}

/** Seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_SCENARIO: Scenario = {
  kind: 'ok',
  ttftMs: 0,
  tokensPerSec: 0,
  pingEveryMs: null,
  outputTokens: 16,
};
