// The two-read settle of a changing policy directory (S-V3-2) with scripted reads, so the order of what the loader
// sees is exact: M4 (V3 review) a second read that fails at start, because a file was caught mid-write after the
// first read passed, is one more unstable pair and is read again, not a failed start; M3 a directory that never
// settles keeps the old revision serving and is counted and reported every MAX_UNSTABLE_READS reads, not silent.
import { afterEach, expect, test, vi } from 'vitest';
import { parsePolicyFiles, PolicyLoadError, type PolicySource } from '../../src/policy/load-dir.js';
import { EXAMPLE_PRICES } from '../policy/helpers.js';
import { keysYaml, policyYaml, sleep, tempDir } from '../helpers/policy-dir.js';

/** What each read of the directory returns, in order; the last entry repeats. */
const script: { reads: Array<() => PolicySource>; n: number } = { reads: [], n: 0 };
vi.mock('../../src/policy-loader/load-dir.js', () => ({
  loadPolicyDir: async (): Promise<PolicySource> => {
    const read = script.reads[Math.min(script.n, script.reads.length - 1)];
    script.n++;
    if (!read) throw new Error('no read scripted');
    return read();
  },
}));
const { MAX_UNSTABLE_READS, PolicyLoader } = await import('../../src/policy-loader/loader.js');

const source = (name: string) => (): PolicySource => parsePolicyFiles('t', { 'policy.yaml': policyYaml('http://127.0.0.1:1', name), 'prices.yaml': EXAMPLE_PRICES, 'keys.yaml': keysYaml() });
const midWrite = (): PolicySource => {
  throw new PolicyLoadError('E_YAML_SYNTAX', 'policy.yaml', [{ path: '', message: 'unexpected end of the stream' }]);
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  script.reads = [];
  script.n = 0;
});

function loader(o: { pollMs?: number } = {}) {
  const l = new PolicyLoader({ dir: tempDir(), stateDir: tempDir('ty-state-'), pollMs: o.pollMs ?? 60_000, debounceMs: 5, experimentalSubscription: false });
  const errors: string[] = [];
  l.on('error', (e: Error) => errors.push(e.message));
  cleanups.push(() => l.stop());
  return { l, errors };
}

test('M4 at start, a second read that fails (a file caught mid-write after the first read passed) is read again, not a failed start', async () => {
  script.reads = [source('one'), midWrite, source('one')];
  const { l, errors } = loader();
  await l.start();
  expect(l.active().budgets.length).toBe(4);
  expect(l.loadErrors).toBe(0);
  expect(errors).toEqual([]);
});

test('M4 a broken file on the first read at start still fails the start (nothing to compare it with)', async () => {
  script.reads = [midWrite];
  const { l } = loader();
  await expect(l.start()).rejects.toThrow(/cannot start/);
});

test('M3 a directory that never settles keeps the old revision, and is counted and reported every MAX_UNSTABLE_READS reads', async () => {
  script.reads = [source('one')];
  const { l, errors } = loader({ pollMs: 10 });
  await l.start();
  const rev = l.active().revision;
  // From now on every read differs from the one before it.
  let flip = 0;
  script.reads = [() => source(flip++ % 2 === 0 ? 'two' : 'three')()];
  script.n = 0;
  await expect.poll(() => l.loadErrors, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(errors.some((m) => m.includes(`kept changing over ${MAX_UNSTABLE_READS} reads`))).toBe(true);
  expect(script.n).toBeGreaterThanOrEqual(MAX_UNSTABLE_READS);
  expect(l.active().revision).toBe(rev);
  // Once it settles, the new revision activates and the count stops growing.
  script.reads = [source('three')];
  await expect.poll(() => l.active().revision, { timeout: 10_000 }).not.toBe(rev);
  const settled = l.loadErrors;
  await sleep(200);
  expect(l.loadErrors).toBe(settled);
}, 30_000);
