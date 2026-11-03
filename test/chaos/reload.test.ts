// V3 chaos, scenario 4: hot reload while requests run. A policy file caught mid-write that still validates (the budgets
// section not written yet) must never become the active policy (Task 11 minor), a corrupted bundle, an empty file and a
// flapping policy URL keep the last good policy serving, and requests in flight settle cleanly through every swap.
import { renameSync, writeFileSync } from 'node:fs';
import { Agent, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { buildBundle, serializeBundle } from '../../src/policy/bundle.js';
import { parsePolicyFiles } from '../../src/policy/load-dir.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import { PolicyLoader, type PolicyLoaderOptions } from '../../src/policy-loader/loader.js';
import { EXAMPLE_PRICES } from '../policy/helpers.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';
import { keysYaml, policyYaml, sleep, tempDir, writePolicyDir } from '../helpers/policy-dir.js';
import { chaosRequest, chatBody, expectStoreClean, sseMessage, unhandledRejections } from './harness.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function loader(o: Partial<PolicyLoaderOptions>): Promise<{ l: PolicyLoader; activated: CompiledPolicy[] }> {
  const l = new PolicyLoader({ stateDir: tempDir('ty-state-'), pollMs: 60_000, debounceMs: 100, experimentalSubscription: false, ...o });
  const activated: CompiledPolicy[] = [];
  l.on('loaded', (p: CompiledPolicy) => activated.push(p));
  l.on('error', () => undefined);
  await l.start();
  cleanups.push(() => l.stop());
  return { l, activated };
}

/** policy.yaml cut right before its `budgets:` section: still a valid policy, with no budget at all. */
const withoutBudgets = (full: string): string => full.slice(0, full.indexOf('\nbudgets:') + 1);

test('a policy file caught mid-write that still validates (budgets not yet written) never becomes the active policy', async () => {
  const dir = tempDir();
  writePolicyDir(dir, 'http://127.0.0.1:1', 'one');
  const { l, activated } = await loader({ dir });
  const full = policyYaml('http://127.0.0.1:1', 'two');
  const cut = withoutBudgets(full);
  expect(cut.length).toBeLessThan(full.length);
  // An editor or `cp` writing in place: the first part lands, the rest 160 ms later (longer than the 100 ms debounce).
  writeFileSync(join(dir, 'policy.yaml'), cut);
  await sleep(160);
  writeFileSync(join(dir, 'policy.yaml'), full);
  await expect.poll(() => l.active().budgets.length, { timeout: 5_000 }).toBeGreaterThan(0);
  await expect.poll(() => activated.at(-1)?.revision).toBe(l.active().revision);
  await sleep(300);
  for (const p of activated) expect(p.budgets.length, `activated revision ${p.revision}`).toBeGreaterThan(0);
  expect(l.active().budgets.length).toBe(4);
});

test('a policy that is the same on two reads a settle interval apart activates (an atomic write)', async () => {
  const dir = tempDir();
  writePolicyDir(dir, 'http://127.0.0.1:1', 'one');
  const { l } = await loader({ dir });
  const first = l.active().revision;
  writePolicyDir(dir, 'http://127.0.0.1:1', 'two');
  await expect.poll(() => l.active().revision, { timeout: 5_000 }).not.toBe(first);
});

test('an empty policy file keeps the old revision serving and counts one load error', async () => {
  const dir = tempDir();
  writePolicyDir(dir, 'http://127.0.0.1:1', 'one');
  const { l } = await loader({ dir });
  const rev = l.active().revision;
  writeFileSync(join(dir, 'policy.yaml'), '');
  // 10 s, not 3: the load error needs the poll, the debounce and the two-read settle, and the full suite runs files in
  // parallel (one miss in four full runs during V4).
  await expect.poll(() => l.loadErrors, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(l.active().revision).toBe(rev);
}, 15_000);

// ---- under load --------------------------------------------------------------------------------------------------

/** An upstream answering every request with a short stream that carries usage. */
async function okUpstream(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseMessage({ input: 10, output: 20 }).join(''));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => (server.close(() => r()), server.closeAllConnections())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The test policy with rate and stream limits far above the load these cases send. */
const loadPolicyYaml = (upstream: string, name: string): string => policyYaml(upstream, name).replace('rpm: 120, burst: 30', 'rpm: 1000000, burst: 100000').replace('concurrentStreams: 8', 'concurrentStreams: 10000');

/** writePolicyDir with loadPolicyYaml, policy.yaml written last and atomically. */
function writeLoadDir(dir: string, upstream: string, name: string): void {
  writePolicyDir(dir, upstream, name);
  writeFileSync(join(dir, '.policy.yaml.tmp'), loadPolicyYaml(upstream, name));
  renameSync(join(dir, '.policy.yaml.tmp'), join(dir, 'policy.yaml'));
}

const bundleText = (upstream: string, name: string): string =>
  serializeBundle(buildBundle(parsePolicyFiles('t', { 'policy.yaml': loadPolicyYaml(upstream, name), 'prices.yaml': EXAMPLE_PRICES, 'keys.yaml': keysYaml() }), { createdAt: '2026-11-03T00:00:00.000Z' }));

async function gatewayOn(l: PolicyLoader) {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const runtime = createGatewayRuntime();
  const memory = createMemoryStore({ clock: Date.now, onSwept: (ids) => runtime.onSwept(ids) });
  const records: unknown[] = [];
  const g = await startGateway({ policy: () => l.active(), store: memory, runtime, traceSalt: 's', traces: { write: (r) => (records.push(r), true) }, clock: () => Date.now() });
  cleanups.push(() => g.close());
  return { url: g.url, memory, records };
}

/**
 * `n` requests spread over 300 ms. At most 64 connections are open at once: macOS accepts at most 128 pending
 * connections per listener (kern.ipc.somaxconn), and with 300 at once a busy machine reset some before the gateway
 * read them (ECONNRESET, status 0), which says nothing about reloads.
 */
async function load(url: string, n: number, prefix: string): Promise<number[]> {
  const agent = new Agent({ keepAlive: false, maxSockets: 64 });
  try {
    return await Promise.all(Array.from({ length: n }, async (_, i) => {
      await sleep((i % 50) * 6);
      return (await chaosRequest(url, `${prefix}${i}`, chatBody(`${prefix}${i}`), { kind: 'normal' }, agent)).status ?? 0;
    }));
  } finally {
    agent.destroy();
  }
}

test('under load: in-place writes, an empty file and atomic swaps of the policy directory; every request answered and settled', async () => {
  const up = await okUpstream();
  const dir = tempDir();
  const write = (name: string): void => writeLoadDir(dir, up, name);
  write('v0');
  const { l } = await loader({ dir, debounceMs: 30 });
  const g = await gatewayOn(l);
  const churn = (async () => {
    for (let i = 1; i <= 6; i++) {
      await sleep(40);
      const full = loadPolicyYaml(up, `v${i}`);
      if (i % 3 === 0) writeFileSync(join(dir, 'policy.yaml'), '');
      else if (i % 3 === 1) writeFileSync(join(dir, 'policy.yaml'), withoutBudgets(full));
      await sleep(20);
      write(`v${i}`);
    }
  })();
  const statuses = await load(g.url, 300, 'rl');
  await churn;
  expect(statuses.filter((s) => s !== 200)).toEqual([]);
  await expect.poll(() => g.records.length).toBe(300);
  await expectStoreClean(g.memory);
  expect(unhandledRejections()).toEqual([]);
});

test('under load: a flapping policy URL (good, corrupted, 500, refused, 304, truncated, good) keeps the last good policy serving', async () => {
  const up = await okUpstream();
  let step = 0;
  const texts = [bundleText(up, 'u1'), bundleText(up, 'u2')];
  const server = createServer((req, res) => {
    step++;
    const kind = step % 6;
    if (kind === 0) return res.writeHead(200, { etag: '"1"' }).end(texts[0]);
    if (kind === 1) return res.writeHead(200).end('{"manifest": {"sha256": "00"}, "files": ');
    if (kind === 2) return res.writeHead(500).end('oops');
    if (kind === 3) return void req.socket.destroy();
    if (kind === 4) return res.writeHead(200, { etag: '"2"' }).end(texts[1]);
    return res.writeHead(200).end((texts[1] as string).slice(0, 200));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => (server.close(() => r()), server.closeAllConnections())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b`;
  // Starts on the first good answer, then polls every 20 ms through the flapping sequence.
  step = -1;
  const { l } = await loader({ url, pollMs: 20 });
  const g = await gatewayOn(l);
  const statuses = await load(g.url, 300, 'fl');
  expect(statuses.filter((s) => s !== 200)).toEqual([]);
  expect(l.loadErrors).toBeGreaterThan(0);
  expect(l.active().budgets.length).toBe(4);
  await expect.poll(() => g.records.length).toBe(300);
  await expectStoreClean(g.memory);
  expect(unhandledRejections()).toEqual([]);
});
