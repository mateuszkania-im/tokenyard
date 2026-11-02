import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CounterStore } from '../../src/limits/store.js';
import { startSweeper } from '../../src/limits/sweeper.js';

beforeEach(() => {
  vi.useFakeTimers({ now: 5_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeStore(sweep: (now: number) => Promise<number>): CounterStore {
  return {
    admit: async () => ({ admitted: true, failed: null, audit: [], totals: [] }),
    settle: async () => 'unknown',
    sweep,
    snapshot: async () => ({}),
    seed: async () => {},
  };
}

test('every tick calls onTick (trace heartbeat) and sweeps at the current time', async () => {
  const swept: number[] = [];
  let ticks = 0;
  const stop = startSweeper(fakeStore(async (now) => (swept.push(now), 0)), { intervalMs: 30_000, onTick: () => ticks++ });
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(ticks).toBe(2);
  expect(swept).toEqual([35_000, 65_000]);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(ticks).toBe(2);
});

test('a lock that is not acquired skips the sweep but still ticks', async () => {
  const swept: number[] = [];
  let ticks = 0;
  let free = false;
  const stop = startSweeper(fakeStore(async (now) => (swept.push(now), 0)), { intervalMs: 1_000, onTick: () => ticks++, lock: { acquire: async () => free } });
  await vi.advanceTimersByTimeAsync(1_000);
  free = true;
  await vi.advanceTimersByTimeAsync(1_000);
  stop();
  expect(ticks).toBe(2);
  expect(swept).toEqual([7_000]);
});

test('a failing sweep or lock does not stop the sweeper, and ticks never overlap', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const stop = startSweeper(
    fakeStore(async () => {
      calls++;
      if (calls === 1) throw new Error('store down');
      if (calls === 2) await new Promise<void>((r) => (release = r));
      return 0;
    }),
    { intervalMs: 1_000 },
  );
  await vi.advanceTimersByTimeAsync(1_000); // throws
  await vi.advanceTimersByTimeAsync(1_000); // hangs
  await vi.advanceTimersByTimeAsync(3_000); // skipped while the previous sweep runs
  expect(calls).toBe(2);
  release();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(3);
  stop();
});
