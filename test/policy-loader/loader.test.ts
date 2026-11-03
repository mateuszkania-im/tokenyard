import { Agent, createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { buildBundle, serializeBundle } from '../../src/policy/bundle.js';
import { parsePolicyFiles } from '../../src/policy/load-dir.js';
import { fetchBundle, checkPolicyUrl } from '../../src/policy-loader/fetch-bundle.js';
import { LKG_FILE } from '../../src/policy-loader/lkg.js';
import { PolicyLoader, type PolicyLoaderOptions } from '../../src/policy-loader/loader.js';
import { EXAMPLE_PRICES } from '../policy/helpers.js';
import { startRawUpstream, authHeaders, msgBody, send } from '../helpers/conformance.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';
import { keysYaml, policyYaml, sleep, tempDir, writePolicyDir } from '../helpers/policy-dir.js';

const UP = 'http://127.0.0.1:1';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function started(o: Partial<PolicyLoaderOptions> & { dir?: string; url?: string }): Promise<PolicyLoader> {
  const l = new PolicyLoader({ stateDir: tempDir('ty-state-'), pollMs: 100, debounceMs: 20, experimentalSubscription: false, ...o });
  l.on('error', () => undefined);
  await l.start();
  cleanups.push(() => l.stop());
  return l;
}

const bundleText = (upstream: string, name: string): string =>
  serializeBundle(buildBundle(parsePolicyFiles('t', { 'policy.yaml': policyYaml(upstream, name), 'prices.yaml': EXAMPLE_PRICES, 'keys.yaml': keysYaml() }), { createdAt: '2026-11-02T00:00:00.000Z' }));
const revisionOf = (text: string): string => (JSON.parse(text) as { manifest: { revision: string } }).manifest.revision;

test('file change swaps the snapshot; in-flight request keeps its revision', async () => {
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  const l = await started({ dir });
  const inFlight = l.active();
  const first = inFlight.revision;
  writePolicyDir(dir, UP, 'two');
  await expect.poll(() => l.active().revision).not.toBe(first);
  expect(inFlight.revision).toBe(first);
  expect(inFlight.routes.length).toBeGreaterThan(0);
  expect(l.loadErrors).toBe(0);
});

test('the watcher alone reloads: with the poll a minute away, a new revision and then a broken file are both noticed', async () => {
  // The other reload tests poll every 100 ms to 1 s as a backup for a watcher event a loaded machine delivers late;
  // this one leaves only the watcher, so a broken watcher fails here (V5 review). The waits are generous, not tight.
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  const l = await started({ dir, pollMs: 60_000 });
  const first = l.active().revision;
  writePolicyDir(dir, UP, 'two');
  await expect.poll(() => l.active().revision, { timeout: 12_000 }).not.toBe(first);
  const second = l.active().revision;
  writeFileSync(join(dir, 'policy.yaml'), 'apiVersion: [unclosed');
  await expect.poll(() => l.loadErrors, { timeout: 12_000 }).toBe(1);
  expect(l.active().revision).toBe(second);
}, 30_000);

test('swap under load: 200 concurrent requests during 5 swaps, zero failed', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const mock = await startAnthropicMock();
  cleanups.push(() => mock.close());
  const dir = tempDir();
  writePolicyDir(dir, mock.url, 'v0');
  const l = await started({ dir });
  const { createGateway } = await import('../../src/edge/server.js');
  let n = 0;
  const g = createGateway({ policy: () => l.active(), store: null, traces: null, clock: Date.now, newId: () => `req_${++n}`, basePath: null, bodyCapBytes: 1 << 20, experimentalSubscription: false });
  const url = await g.listen(0, '127.0.0.1');
  cleanups.push(() => g.close());

  const results: Array<{ status: number; rev: string }> = [];
  // At most 64 client connections: below the OS listen backlog (128 on macOS), which a loaded test run could overflow.
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });
  cleanups.push(async () => agent.destroy());
  const swapper = (async () => {
    // 80 ms apart: a revision activates once two reads a settle interval (20 ms) apart agree (V3).
    for (let i = 1; i <= 5; i++) {
      await sleep(80);
      writePolicyDir(dir, mock.url, `v${i}`);
    }
  })();
  const requests = Array.from({ length: 200 }, async (_, i) => {
    // Spread over about 1 s, past the last swap (400 ms) and its settle reads even on a loaded runner.
    await sleep((i % 40) * 25);
    const r = await send(url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-sonnet-5-5' }), agent });
    results.push({ status: r.status, rev: String(r.headers['x-tokenyard-policy-revision']) });
  });
  await Promise.all([swapper, ...requests]);
  expect(results).toHaveLength(200);
  expect(results.filter((r) => r.status !== 200)).toEqual([]);
  expect(new Set(results.map((r) => r.rev)).size).toBeGreaterThan(1);
  await expect.poll(() => l.active().revision).not.toBe(results[0]?.rev);
  expect(l.loadErrors).toBe(0);
});

test('broken file keeps the old revision and increments loadErrors', async () => {
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  const l = await started({ dir });
  const rev = l.active().revision;
  const errors: Error[] = [];
  l.on('error', (e: Error) => errors.push(e));
  writeFileSync(join(dir, 'policy.yaml'), 'apiVersion: [unclosed');
  await expect.poll(() => l.loadErrors).toBe(1);
  await sleep(350); // several polls find the same broken file: still one failure
  expect(l.loadErrors).toBe(1);
  expect(l.active().revision).toBe(rev);
  expect(errors[0]?.message).toMatch(/E_YAML|E_SCHEMA/);
});

test('the same broken file found again by the watcher is still one failure (a loaded machine spreads one write over two events)', async () => {
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  // The poll (every 500 ms) is the fallback when a loaded machine delivers a watcher event late; both dedupe now.
  const l = await started({ dir, pollMs: 500 });
  const rev = l.active().revision;
  writeFileSync(join(dir, 'policy.yaml'), 'apiVersion: [unclosed');
  await expect.poll(() => l.loadErrors, { timeout: 10_000 }).toBe(1);
  // The same content written again: the watcher fires, the reload finds the same failure; so does the next poll.
  writeFileSync(join(dir, 'policy.yaml'), 'apiVersion: [unclosed');
  await sleep(1_200);
  expect(l.loadErrors).toBe(1);
  expect(l.active().revision).toBe(rev);
  // A different failure counts again.
  writeFileSync(join(dir, 'policy.yaml'), 'apiVersion: {unclosed');
  await expect.poll(() => l.loadErrors, { timeout: 10_000 }).toBe(2);
});

test('truncated mid-write then complete write: old revision serves, then the new one activates', async () => {
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  const l = await started({ dir });
  const rev = l.active().revision;
  const full = policyYaml(UP, 'two');
  // An editor that truncates and writes in two steps: the watcher can fire between them.
  writeFileSync(join(dir, 'policy.yaml'), '');
  await expect.poll(() => l.loadErrors).toBeGreaterThanOrEqual(1);
  writeFileSync(join(dir, 'policy.yaml'), full.slice(0, Math.floor(full.length / 2)));
  await sleep(120);
  expect(l.active().revision).toBe(rev);
  writeFileSync(join(dir, 'policy.yaml'), full);
  await expect.poll(() => l.active().revision).not.toBe(rev);
  expect(l.active().revision).toHaveLength(12);
});

test('URL source: If-None-Match sent, 304 keeps snapshot, redirect is an error', async () => {
  let text = bundleText(UP, 'one');
  let etag = '"e1"';
  let mode: 'ok' | 'redirect' = 'ok';
  const seen: Array<string | undefined> = [];
  const srv = await startRawUpstream((req, res) => {
    seen.push(req.headers['if-none-match']);
    if (mode === 'redirect') return void res.writeHead(302, { location: 'http://127.0.0.1:1/x' }).end();
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304).end();
    res.writeHead(200, { etag, 'content-type': 'application/json' }).end(text);
  });
  cleanups.push(() => srv.close());
  const l = await started({ url: `${srv.url}/bundle.json` });
  const first = l.active().revision;
  expect(first).toBe(revisionOf(text));
  await expect.poll(() => seen.includes('"e1"')).toBe(true);
  expect(l.loadErrors).toBe(0);
  expect(l.active().revision).toBe(first);

  text = bundleText(UP, 'two');
  etag = '"e2"';
  await expect.poll(() => l.active().revision).toBe(revisionOf(text));

  mode = 'redirect';
  const before = l.active().revision;
  await expect.poll(() => l.loadErrors).toBe(1);
  await sleep(250);
  expect(l.loadErrors).toBe(1);
  expect(l.active().revision).toBe(before);
});

test('URL fetch: https only, loopback http allowed, size and time caps', async () => {
  expect(() => checkPolicyUrl('http://example.com/b.json')).toThrow(/https/);
  expect(() => checkPolicyUrl('ftp://example.com/b.json')).toThrow(/https/);
  expect(() => checkPolicyUrl('https://user:pw@example.com/b.json')).toThrow(/credentials/);
  expect(checkPolicyUrl('https://example.com/b.json').protocol).toBe('https:');
  expect(checkPolicyUrl('http://localhost:1/b.json').protocol).toBe('http:');

  const big = await startRawUpstream((_req, res) => void res.writeHead(200).end('x'.repeat(5000)));
  cleanups.push(() => big.close());
  await expect(fetchBundle(`${big.url}/b`, { etag: null, maxBytes: 1000 })).rejects.toThrow(/larger than 1000/);
  const hang = createServer(() => undefined);
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
  cleanups.push(() => { hang.closeAllConnections(); hang.close(); });
  const port = (hang.address() as { port: number }).port;
  await expect(fetchBundle(`http://127.0.0.1:${port}/b`, { etag: null, timeoutMs: 100 })).rejects.toThrow(/did not answer/);
});

test('URL bundle with wrong sha256 is rejected and the old revision stays', async () => {
  let text = bundleText(UP, 'one');
  const srv = await startRawUpstream((_req, res) => void res.writeHead(200).end(text));
  cleanups.push(() => srv.close());
  const l = await started({ url: `${srv.url}/b` });
  const rev = l.active().revision;
  const bad = JSON.parse(bundleText(UP, 'two')) as { manifest: { sha256: string } };
  bad.manifest.sha256 = '0'.repeat(64);
  text = JSON.stringify(bad);
  await expect.poll(() => l.loadErrors).toBe(1);
  expect(l.active().revision).toBe(rev);
});

test('unreachable source at start uses last-known-good from stateDir; none and no source refuses to start', async () => {
  const stateDir = tempDir('ty-state-');
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  const l1 = await started({ dir, stateDir });
  const rev = l1.active().revision;
  await l1.stop();
  expect(readdirSync(stateDir)).toEqual([LKG_FILE]); // atomic write leaves no temp file

  const l2 = new PolicyLoader({ url: 'http://127.0.0.1:1/bundle.json', stateDir, experimentalSubscription: false, pollMs: 100 });
  l2.on('error', () => undefined);
  await l2.start();
  cleanups.push(() => l2.stop());
  expect(l2.active().revision).toBe(rev);
  expect(l2.loadErrors).toBe(1);

  await expect(new PolicyLoader({ url: 'http://127.0.0.1:1/bundle.json', stateDir: tempDir('ty-empty-'), experimentalSubscription: false }).start()).rejects.toThrow(/cannot start/);
  await expect(new PolicyLoader({ stateDir: tempDir('ty-empty-'), experimentalSubscription: false }).start()).rejects.toThrow(/cannot start/);
  await expect(new PolicyLoader({ dir: tempDir('ty-nodir-'), stateDir: tempDir('ty-empty-'), experimentalSubscription: false }).start()).rejects.toThrow(/cannot start/);
});

test('a tampered last-known-good is refused', async () => {
  const stateDir = tempDir('ty-state-');
  const dir = tempDir();
  writePolicyDir(dir, UP, 'one');
  const l1 = await started({ dir, stateDir });
  await l1.stop();
  const file = join(stateDir, LKG_FILE);
  const env = JSON.parse(readFileSync(file, 'utf8')) as { sha256: string; bundle: string };
  writeFileSync(file, JSON.stringify({ ...env, bundle: env.bundle.replace('"one"', '"evil"').replace('one', 'evil') }));
  await expect(new PolicyLoader({ url: 'http://127.0.0.1:1/b', stateDir, experimentalSubscription: false }).start()).rejects.toThrow(/sha256 mismatch/);
  // Even with the envelope hash recomputed by the attacker, the manifest hash over the content no longer matches.
  const { createHash } = await import('node:crypto');
  const forged = env.bundle.replace(/"name": "one"/, '"name": "evil"');
  expect(forged).not.toBe(env.bundle);
  writeFileSync(file, JSON.stringify({ sha256: createHash('sha256').update(forged).digest('hex'), bundle: forged }));
  await expect(new PolicyLoader({ url: 'http://127.0.0.1:1/b', stateDir, experimentalSubscription: false }).start()).rejects.toThrow(/sha256 mismatch/);
  rmSync(file);
  expect(existsSync(file)).toBe(false);
});

test('candidate policy is attached for audit mode; a broken candidate does not stop the gateway', async () => {
  const dir = tempDir();
  const cand = tempDir();
  writePolicyDir(dir, UP, 'live');
  writePolicyDir(cand, UP, 'cand');
  const l = await started({ dir, candidateDir: cand });
  const c1 = l.active().candidate;
  expect(c1).not.toBeNull();
  expect(c1?.revision).not.toBe(l.active().revision);
  writePolicyDir(cand, UP, 'cand2');
  await expect.poll(() => l.active().candidate?.revision).not.toBe(c1?.revision);
  expect(l.active().candidate?.candidate).toBeNull();

  const broken = tempDir();
  const l2 = await started({ dir, candidateDir: broken });
  expect(l2.active().candidate).toBeNull();
  expect(l2.loadErrors).toBe(1);
});
