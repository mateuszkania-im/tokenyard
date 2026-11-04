// Shared settings for the V4 property tests and fuzzers (docs/testing.md). Every run is deterministic: each property
// has a fixed seed, so a failure in CI reproduces locally with the same command. `npm run test:fuzz` sets
// TOKENYARD_FUZZ=1, which multiplies the number of runs; TOKENYARD_FUZZ_SEED replaces every seed (exploration: a
// failing seed is printed by fast-check together with the shrunk counterexample and its path).
import type { Parameters } from 'fast-check';

export const LONG_FUZZ = process.env.TOKENYARD_FUZZ === '1';
/** How many times more runs `npm run test:fuzz` makes than the default suite. */
export const LONG_FACTOR = 20;

const seedOverride = process.env.TOKENYARD_FUZZ_SEED === undefined ? null : Number(process.env.TOKENYARD_FUZZ_SEED);
if (seedOverride !== null && !Number.isSafeInteger(seedOverride)) throw new Error('TOKENYARD_FUZZ_SEED must be an integer');

/** fast-check parameters: the property's own seed (or the override) and `runs` runs, times LONG_FACTOR in the long run. */
export function fuzz<T>(seed: number, runs: number, extra: Parameters<T> = {}): Parameters<T> {
  return { seed: seedOverride ?? seed, numRuns: LONG_FUZZ ? runs * LONG_FACTOR : runs, ...extra };
}

/** Test timeout that grows with the long run, for properties whose runs each take real time (gateways, Redis). */
export const fuzzTimeout = (ms: number): number => (LONG_FUZZ ? ms * LONG_FACTOR : ms);
