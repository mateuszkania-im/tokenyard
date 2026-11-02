import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { EXAMPLE_BASE, EXAMPLE_HEAD } from '../src/demo/example-files.js';
import { runDemo } from '../src/demo/run.js';
import { readLedger } from '../src/ledger/reader.js';
import { loadReplayPolicy } from '../src/policy-loader/replay-input.js';
import { loadPolicyDir } from '../src/policy-loader/load-dir.js';
import { validatePolicy } from '../src/policy/validate.js';
import { replay } from '../src/replay/engine.js';

class Sink extends Writable {
  text = '';
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-demo-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('demo runs in one process without Docker in under 60 s and ends with a report showing a reroute, a budget hit and the secret block', async () => {
  const out = new Sink();
  const t0 = Date.now();
  const r = await runDemo({ out, seed: 1, writeTraces: join(dir, 'demo.ndjson.gz') });
  expect(Date.now() - t0).toBeLessThan(60_000);
  expect(r.rerouted.length).toBeGreaterThan(0);
  expect(r.budgetHits.some((h) => h.policy === 'head' && h.budget === 'team-day' && h.scopeValue.includes('web'))).toBe(true);
  expect(r.blocked.some((b) => b.reason === 'secret')).toBe(true);
  expect(r.fidelity.agreement).toBe(1);
  expect(out.text).toContain('tokenyard policy replay');
  expect(out.text).toContain('Rerouted requests');
  expect(out.text).toMatch(/claude-code-compaction/);
  expect(out.text).toMatch(/team-day web/);
  expect(out.text).toMatch(/\d+ x secret/);
  // The committed file is what this seed generates today: regenerate it with `node bin/tokenyard.mjs demo --write-traces examples/traces/demo.ndjson.gz` when the generator or the example policy changes.
  expect(gunzipSync(await readFile(join(dir, 'demo.ndjson.gz'))).equals(gunzipSync(await readFile('examples/traces/demo.ndjson.gz')))).toBe(true);
}, 90_000);

test('the committed demo traces replay against their own revision with fidelity 100%', async () => {
  const base = await loadReplayPolicy({ source: 'examples/policy', headDir: 'examples/policy-head', experimentalSubscription: false });
  const head = await loadReplayPolicy({ source: 'examples/policy-head', headDir: 'examples/policy-head', experimentalSubscription: false });
  const r = await replay({ base, head, traces: readLedger(['examples/traces/demo.ndjson.gz']), sinceMs: null, tenant: null });
  expect(r.fidelity.agreement).toBe(1);
  expect(r.fidelity.missingInstances).toEqual([]);
  expect(r.rerouted.length).toBeGreaterThan(0);
  expect(r.budgetHits.length).toBeGreaterThan(0);
  expect(r.blocked.some((b) => b.reason === 'secret')).toBe(true);
});

test('the demo PR policy passes policy check and the embedded copies match the example files', async () => {
  const { errors } = validatePolicy(await loadPolicyDir('examples/policy-head'), { experimentalSubscription: false });
  expect(errors).toEqual([]);
  for (const [name, dirName] of [[EXAMPLE_BASE, 'policy'], [EXAMPLE_HEAD, 'policy-head']] as const) {
    for (const f of ['policy.yaml', 'prices.yaml', 'keys.yaml']) expect(name[f]).toBe(readFileSync(join('examples', dirName, f), 'utf8'));
  }
  for (const f of ['prices.yaml', 'keys.yaml']) expect(readFileSync(join('examples', 'policy-head', f), 'utf8')).toBe(readFileSync(join('examples', 'policy', f), 'utf8'));
});
