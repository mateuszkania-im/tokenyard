// `serve --workers <n>`: option checks (every platform), and on a real Redis (`npm run test:redis`) two workers on one
// port, traces per worker with distinct instance ids that export and replay as several instances, the G4 budget proof
// spread over the workers, and the drain on SIGTERM.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClient } from 'redis';
import { afterEach, expect, test } from 'vitest';
import { createRedisStore } from '../../src/limits/redis-store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { authHeaders, msgBody, send, startRawUpstream } from '../helpers/conformance.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';
import { policyYaml, rewritePolicyDir, tempDir, writePolicyDir } from '../helpers/policy-dir.js';

const run = promisify(execFile);
const REDIS = process.env.REDIS_URL;
// SIGTERM reaches a handler on POSIX only: on Windows child.kill('SIGTERM') is TerminateProcess (serve-shutdown.test.ts).
const signals = process.platform !== 'win32';
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const noRateLimits = (y: string): string => y.replace(/^rateLimits:\n(?: {2}- .*\n)+/m, 'rateLimits: []\n');

function policyDir(upstream: string, edit: (yaml: string) => string = (y) => y): string {
  const dir = tempDir();
  writePolicyDir(dir, upstream, 'workers');
  writeFileSync(join(dir, 'policy.yaml'), edit(policyYaml(upstream, 'workers')));
  return dir;
}

test('serve --workers refuses 0, negative, fractional, non-numeric and more than the CPU count', async () => {
  const dir = policyDir('http://127.0.0.1:1');
  const base = ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--no-metrics'];
  for (const n of ['0', '-1', '1.5', 'two', '100000']) {
    await expect(run('node', [...base, '--workers', n])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--workers must be a whole number from 1 to') });
  }
});

test('serve --workers 2 refuses the memory store: each process would keep its own budgets', async () => {
  const dir = policyDir('http://127.0.0.1:1');
  await expect(run('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--no-metrics', '--workers', '2'])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--workers 2 needs --store redis'),
  });
});

test('serve --workers 1 is the single process of before: it serves and prints its URL', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', mock.url, '--no-metrics', '--workers', '1'], { env: { ...process.env, TOKENYARD_DEV_UPSTREAM_KEY: 'x' } });
  closers.push(() => void child.kill('SIGKILL'));
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
    child.once('exit', () => reject(new Error(`serve exited early: ${err}`)));
  });
  const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { ...authHeaders, 'x-api-key': 'ty_live_dev' }, body: new Uint8Array(msgBody({ model: 'claude-haiku-5-5' })) });
  expect(res.status).toBe(200);
  expect(err).not.toContain('workers ready');
});

test('serve --workers 2 refuses an ops port range past 65535', async () => {
  const dir = policyDir('http://127.0.0.1:1');
  await expect(
    run('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--store', 'redis', '--redis-url', 'redis://127.0.0.1:1', '--workers', '2', '--metrics-port', '65535'], {
      env: { ...process.env, TOKENYARD_TRACE_SALT: 's' },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--metrics-port 65535 with --workers 2 needs ports up to 65536') });
});

interface Served {
  child: ChildProcessWithoutNullStreams;
  url: string;
  traces: string;
  stderr: () => string;
  exited: Promise<number | null>;
}

async function serveWorkers(dir: string, extra: string[]): Promise<Served> {
  const traces = tempDir('ty-traces-');
  const args = ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--trace-dir', traces, '--store', 'redis', ...extra];
  const child = spawn('node', args, { env: { ...process.env, [PROVIDER_KEY_ENV]: 'k', TOKENYARD_TRACE_SALT: 's', TOKENYARD_REDIS_URL: REDIS } });
  closers.push(() => void child.kill('SIGKILL'));
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
    void exited.then(() => reject(new Error(`serve exited early: ${err}`)));
  });
  return { child, url, traces, stderr: () => err, exited };
}

type Line = { kind?: string; instance: string; seq?: number; decision?: { reservedMicroUsd: number }; outcome?: { status: number; costMicroUsd: number | null } };
function traceLines(dir: string): { files: string[]; lines: Line[] } {
  const files: string[] = [];
  const lines: Line[] = [];
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith('.ndjson')) continue;
    files.push(f.name);
    for (const l of readFileSync(join(f.parentPath, f.name), 'utf8').split('\n')) if (l !== '') lines.push(JSON.parse(l) as Line);
  }
  return { files, lines };
}
const requests = (lines: Line[]): Line[] => lines.filter((l) => l.outcome !== undefined);

test.runIf(REDIS && signals)('two workers share one port; both serve, both write traces with distinct instance ids; export and replay see two instances', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  // No rate limits: 20 at once would pass the example's 8 concurrent streams per key (held across the workers).
  const dir = policyDir(mock.url, noRateLimits);
  const ops = await freePort();
  const s = await serveWorkers(dir, ['--workers', '2', '--instance-id', 'wtest01', '--metrics-port', String(ops)]);
  expect(s.stderr()).toContain('tokenyard: 2 workers ready');
  // Each request on its own connection, so the primary hands them to the workers in turn.
  const rs = await Promise.all(Array.from({ length: 20 }, () => send(s.url, { path: '/v1/messages', headers: { ...authHeaders, connection: 'close' }, body: msgBody({ model: 'claude-sonnet-5-5' }), agent: new Agent({ keepAlive: false }) })));
  expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
  // One ops listener per worker, on consecutive ports.
  for (const p of [ops, ops + 1]) expect((await fetch(`http://127.0.0.1:${p}/readyz`)).status).toBe(200);
  await new Promise((r) => setTimeout(r, 200));
  s.child.kill('SIGTERM');
  expect(await s.exited).toBe(0);

  const { files, lines } = traceLines(s.traces);
  const reqs = requests(lines);
  expect(reqs).toHaveLength(20);
  const ids = new Set(reqs.map((r) => r.instance));
  expect(ids).toEqual(new Set(['wtest01-w1', 'wtest01-w2']));
  for (const id of ids) {
    expect(files.some((f) => f.endsWith(`.${id}.ndjson`))).toBe(true);
    expect(lines.some((l) => l.kind === 'segment' && l.instance === id)).toBe(true);
    expect(lines.some((l) => l.kind === 'shutdown' && l.instance === id)).toBe(true);
  }

  const out = join(tempDir('ty-export-'), 'export.ndjson');
  await run('node', ['bin/tokenyard.mjs', 'traces', 'export', '--trace-dir', s.traces, '--out', out, '--since', '1d']);
  const manifest = JSON.parse(readFileSync(out, 'utf8').split('\n')[0] as string) as { instances: Array<{ id: string; records: number; seqGaps: number; shutdown: boolean }> };
  expect(manifest.instances.map((i) => i.id).sort()).toEqual(['wtest01-w1', 'wtest01-w2']);
  for (const i of manifest.instances) expect(i).toMatchObject({ seqGaps: 0, shutdown: true });
  expect(manifest.instances.reduce((n, i) => n + i.records, 0)).toBe(20);
  const json = join(tempDir('ty-replay-'), 'replay.json');
  await run('node', ['bin/tokenyard.mjs', 'policy', 'replay', '--base-dir', dir, '--head', dir, '--traces', out, '--json', json], { env: { ...process.env, [PROVIDER_KEY_ENV]: 'k' } });
  const replay = JSON.parse(readFileSync(json, 'utf8')) as { fidelity: { agreement: number; missingInstances: unknown[] } };
  expect(replay.fidelity.missingInstances).toEqual([]);
  expect(replay.fidelity.agreement).toBe(1);
}, 60_000);

test.runIf(REDIS && signals)('a policy change on disk reaches every worker: each loads the policy directory itself', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const dir = policyDir(mock.url);
  const s = await serveWorkers(dir, ['--workers', '2', '--no-metrics']);
  const revisions = (): string[] => [...s.stderr().matchAll(/policy revision (\S+) active/g)].map((m) => m[1] as string);
  expect(revisions()).toHaveLength(2);
  const first = revisions()[0];
  expect(revisions()).toEqual([first, first]);
  await rewritePolicyDir(dir, mock.url, 'workers-v2');
  await expect.poll(() => revisions().filter((r) => r !== first).length, { timeout: 15_000 }).toBe(2);
  s.child.kill('SIGTERM');
  expect(await s.exited).toBe(0);
}, 60_000);

/** Deterministic request shapes from the G4 proof (test/limits/budget-proof.test.ts): reservations differ, each well under $1. */
function proofBody(i: number): Buffer {
  const text = 'x'.repeat(100 + ((i * 7919) % 3_900));
  return Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16 + ((i * 104_729) % 2_000), stream: i % 2 === 0, messages: [{ role: 'user', content: text }] }));
}

test.runIf(REDIS && signals)('G4 across workers: 600 requests at once over 3 workers never take spend past an enforced $1 budget', async () => {
  const mock = await startAnthropicMock({ scenario: { kind: 'randomUsage', seed: 42 } });
  closers.push(mock.close);
  const budget = `proof-${Date.now().toString(36)}`;
  const dir = policyDir(mock.url, (y) => noRateLimits(y.replace(/^budgets:\n(?: {2}- .*\n)+/m, `budgets:\n  - { name: ${budget}, scope: tenant, window: day, usd: 1, onExceed: block }\n`)));
  const s = await serveWorkers(dir, ['--workers', '3', '--no-metrics']);
  const agent = new Agent({ keepAlive: true, maxSockets: 100 });
  closers.push(() => agent.destroy());
  const N = 600;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => send(s.url, { path: '/v1/messages', headers: authHeaders, body: proofBody(i), agent })));
  agent.destroy();
  s.child.kill('SIGTERM');
  expect(await s.exited).toBe(0);

  const reqs = requests(traceLines(s.traces).lines);
  expect(reqs).toHaveLength(N);
  expect(new Set(reqs.map((r) => r.instance)).size).toBe(3); // the load really was spread over the workers
  const admitted = rs.filter((r) => r.status === 200).length;
  const refused = rs.filter((r) => r.status === 429).length;
  expect(admitted).toBeGreaterThan(10);
  expect(refused).toBeGreaterThan(10); // the budget really ran out
  expect(admitted + refused).toBe(N);

  const client = createClient({ url: REDIS });
  await client.connect();
  closers.push(async () => void (await client.close()));
  const keys: string[] = [];
  for await (const batch of client.scanIterator({ MATCH: `*:b:${budget}:*` })) keys.push(...(Array.isArray(batch) ? batch : [batch]));
  expect(keys).toHaveLength(1);
  const key = keys[0] as string;
  const final = (await createRedisStore(client, { deadlineMs: 600_000 }).snapshot([key]))[key] as { spent: number; reserved: number };
  const settled = reqs.reduce((n, r) => n + (r.outcome?.costMicroUsd ?? 0), 0);
  expect(final.reserved).toBe(0);
  expect(final.spent).toBeLessThanOrEqual(1_000_000);
  expect(final.spent).toBe(settled); // no lost update between processes
}, 90_000);

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test.runIf(REDIS && signals)('SIGTERM to the primary drains the workers: a stream in flight finishes at its actual cost and the process exits 0', async () => {
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  const up = await startRawUpstream(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 40, output_tokens: 1 } } }));
    res.write(': marker-sent\n\n');
    await released;
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, output_tokens: 7 } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  closers.push(up.close, () => release());
  const s = await serveWorkers(policyDir(up.url), ['--workers', '2', '--no-metrics', '--shutdown-grace-ms', '20000']);
  let onMarker: () => void = () => undefined;
  const marker = new Promise<void>((r) => (onMarker = r));
  const done = new Promise<string>((resolve) => {
    const u = new URL(s.url);
    let text = '';
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders }, (res) => {
      res.on('data', (c: Buffer) => {
        text += c.toString();
        if (text.includes('marker-sent')) onMarker();
      });
      res.on('end', () => resolve(text));
      res.on('error', () => resolve(text));
    });
    req.on('error', () => resolve(text));
    req.end(msgBody({ model: 'claude-sonnet-5-5', stream: true, max_tokens: 1_000 }));
  });
  await marker;
  s.child.kill('SIGTERM');
  await expect.poll(() => s.stderr()).toContain('tokenyard: draining 2 workers, up to 20000 ms');
  await new Promise((r) => setTimeout(r, 300));
  release();
  expect(await done).toContain('message_stop');
  expect(await s.exited).toBe(0);
  const { lines } = traceLines(s.traces);
  const reqs = requests(lines);
  expect(reqs).toHaveLength(1);
  expect(reqs[0]?.outcome?.status).toBe(200);
  expect(reqs[0]?.outcome?.costMicroUsd ?? 0).toBeGreaterThan(0);
  expect(reqs[0]?.outcome?.costMicroUsd ?? 0).toBeLessThan(reqs[0]?.decision?.reservedMicroUsd ?? 0);
  expect(new Set(lines.filter((l) => l.kind === 'shutdown').map((l) => l.instance)).size).toBeGreaterThanOrEqual(1);
}, 60_000);
