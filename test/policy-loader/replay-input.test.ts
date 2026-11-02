import { afterEach, expect, test } from 'vitest';
import { PolicyLoader } from '../../src/policy-loader/loader.js';
import { loadReplayPolicy } from '../../src/policy-loader/replay-input.js';
import { tempDir } from '../helpers/policy-dir.js';

const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test('the default replay revision of a policy directory is the revision serve --policy records for it', async () => {
  const l = new PolicyLoader({ dir: 'examples/policy', stateDir: tempDir('ty-state-'), pollMs: 60_000, debounceMs: 20, experimentalSubscription: false });
  l.on('error', () => undefined);
  await l.start();
  stops.push(() => l.stop());
  const replayed = await loadReplayPolicy({ source: 'examples/policy', headDir: 'examples/policy', experimentalSubscription: false });
  expect(replayed.revision).toBe(l.active().revision);
  expect(replayed.revision).toMatch(/^[0-9a-f]{12}$/);
});

test('a --base that would read as a git option is refused before git runs', async () => {
  for (const source of ['--output=/tmp/ty-pwned', '-p', '--end-of-options']) {
    await expect(loadReplayPolicy({ source, headDir: 'examples/policy', experimentalSubscription: false })).rejects.toThrow(/not a git ref/);
  }
});

test('an unknown git ref is refused with its name', async () => {
  await expect(loadReplayPolicy({ source: 'no-such-ref-ty', headDir: 'examples/policy', experimentalSubscription: false })).rejects.toThrow(/no-such-ref-ty/);
});

test('a git ref loads the head directory as it was at that ref', async () => {
  const atHead = await loadReplayPolicy({ source: 'HEAD', headDir: 'examples/policy', experimentalSubscription: false });
  const dir = await loadReplayPolicy({ source: 'examples/policy', headDir: 'examples/policy', experimentalSubscription: false });
  expect(atHead.revision).toBe(dir.revision);
});
