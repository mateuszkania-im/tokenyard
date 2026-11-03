// S-V3-3 at full size: 32 MiB minus 4 KiB of short strings (`"a",`), bare tokens (`1,`) or AWS-key-shaped values,
// in the newest turn or in history, on a coding-agent and on a product route. Before the fix: 200 after the event loop
// was held 2.0 to 6.1 s, or 500 (RangeError) with RSS at 1.8 to 2.4 GB. Now each is refused with 413 `scan-budget`,
// nothing reaches the upstream, and both time and memory stay bounded. Run in one child process with --expose-gc, so
// other test files share neither its heap, its RSS nor its event loop, and the 32 MiB bodies go one at a time.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { TIMING_BOUNDS } from '../helpers/timing.js';

const REPO = resolve(import.meta.dirname, '..', '..');

test.skipIf(!TIMING_BOUNDS)('S-V3-3 32 MiB hostile bodies, both routes, last turn and history: 413 scan-budget, nothing sent, bounded loop lag and memory', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), join(REPO, 'test', 'security', 'scan-budget-memory.child.ts')], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  expect(r.status, r.stderr).toBe(0);
  const rows = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '[]') as Array<{
    shape: string; place: string; route: string; status: number; upstream: number; shouldRetry: string; errorType: string;
    decision: unknown; reserved: number; outcomes: number; peakRssMb: number; heapLeftMb: number; lagMs: number; cpuMs: number;
  }>;
  expect(rows).toHaveLength(12);
  for (const row of rows) {
    const what = JSON.stringify(row);
    expect(row.status, what).toBe(413);
    expect(row.upstream, what).toBe(0);
    expect(row.shouldRetry, what).toBe('false');
    expect(row.errorType, what).toBe('request_too_large');
    expect(row.decision, what).toEqual({ action: 'block', reason: 'scan-budget' });
    expect(row.reserved, what).toBe(0);
    // Receiving the body is two copies of it (chunks, then one Buffer): about 64 MiB. Measured: at most about 100 MB
    // over the level before the request (pages freed by an earlier request are reused, so this is a high-water mark).
    expect(row.peakRssMb, what).toBeLessThan(400);
    expect(row.heapLeftMb, what).toBeLessThan(32);
    // The work bound is CPU time, which competing processes do not inflate (the stall did, past 1 s on a loaded machine).
    // Measured: at most about 0.2 s of stall and of CPU (dense matches: the scan stops at its match budget); the CPU
    // time includes the RSS sampler thread and parallel GC. The bound is about four times the measured 0.22 s (V5 review;
    // the child runs uninstrumented, so coverage does not scale it). The stall keeps a ceiling only a hang would reach.
    expect(row.cpuMs, what).toBeLessThan(1_000);
    expect(row.lagMs, what).toBeLessThan(10_000);
  }
}, 150_000);
