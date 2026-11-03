// FR-I1 (final review): `serve` drains on SIGTERM. A stream in flight finishes and its trace line carries the actual
// cost; past --shutdown-grace-ms it is cut and settles at the reservation; a second signal stops at once.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, startRawUpstream } from '../helpers/conformance.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';
import { tempDir, writePolicyDir } from '../helpers/policy-dir.js';

const MODEL = 'claude-sonnet-5-5';
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function heldStream() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  const up = await startRawUpstream(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 40, output_tokens: 1 } } }));
    res.write(': marker-sent\n\n');
    await released;
    if (res.destroyed) return;
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, output_tokens: 7 } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  closers.push(() => release(), up.close);
  return { url: up.url, release };
}

async function serve(upstream: string, extra: string[]): Promise<{ child: ChildProcessWithoutNullStreams; url: string; traces: string; stderr: () => string; exited: Promise<number | null> }> {
  const dir = tempDir();
  writePolicyDir(dir, upstream, 'shutdown');
  const traces = tempDir('ty-traces-');
  const args = ['bin/tokenyard.mjs', 'serve', '--port', '0', '--host', '127.0.0.1', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--trace-dir', traces, '--no-metrics', ...extra];
  const child = spawn('node', args, { env: { ...process.env, [PROVIDER_KEY_ENV]: 'k', TOKENYARD_TRACE_SALT: 's' } });
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

function startStream(url: string): { marker: Promise<void>; done: Promise<string> } {
  let onMarker: () => void = () => undefined;
  const marker = new Promise<void>((r) => (onMarker = r));
  const done = new Promise<string>((resolve) => {
    const u = new URL(url);
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
    req.end(msgBody({ model: MODEL, stream: true, max_tokens: 1_000 }));
  });
  return { marker, done };
}

/** The request lines of every trace file under `dir`. */
type RequestLine = { decision: { reservedMicroUsd: number }; outcome: { status: number; costMicroUsd: number | null; settledAtEstimate?: true } };
function requestRecords(dir: string): RequestLine[] {
  const out: RequestLine[] = [];
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile() || !f.name.endsWith('.ndjson')) continue;
    for (const line of readFileSync(join(f.parentPath, f.name), 'utf8').split('\n')) {
      if (line === '') continue;
      const r = JSON.parse(line) as Partial<RequestLine>;
      if (r.outcome !== undefined) out.push(r as RequestLine);
    }
  }
  return out;
}

test('FR-I1 serve: a stream in flight at SIGTERM finishes, settles at its actual cost, and the process exits 0', async () => {
  const up = await heldStream();
  const s = await serve(up.url, ['--shutdown-grace-ms', '20000']);
  const st = startStream(s.url);
  await st.marker;
  s.child.kill('SIGTERM');
  await expect.poll(() => s.stderr()).toContain('tokenyard: draining, up to 20000 ms');
  up.release();
  expect(await st.done).toContain('message_stop');
  expect(await s.exited).toBe(0);
  const recs = requestRecords(s.traces);
  expect(recs).toHaveLength(1);
  expect(recs[0]!.outcome.status).toBe(200);
  expect(recs[0]!.outcome.settledAtEstimate).toBeUndefined();
  expect(recs[0]!.outcome.costMicroUsd ?? 0).toBeGreaterThan(0);
  expect(recs[0]!.outcome.costMicroUsd ?? 0).toBeLessThan(recs[0]!.decision.reservedMicroUsd);
}, 30_000);

test('FR-I1 serve: a stream past --shutdown-grace-ms is cut and settles at its reservation', async () => {
  const up = await heldStream();
  const s = await serve(up.url, ['--shutdown-grace-ms', '300']);
  const st = startStream(s.url);
  await st.marker;
  const t0 = Date.now();
  s.child.kill('SIGTERM');
  expect(await s.exited).toBe(0);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  expect(await st.done).not.toContain('message_stop');
  const recs = requestRecords(s.traces);
  expect(recs).toHaveLength(1);
  expect(recs[0]!.outcome.settledAtEstimate).toBe(true);
  expect(recs[0]!.outcome.costMicroUsd).toBe(recs[0]!.decision.reservedMicroUsd);
}, 30_000);

test('FR-I1 serve: a second signal closes at once, and a bad --shutdown-grace-ms is refused', async () => {
  const up = await heldStream();
  const s = await serve(up.url, []); // default grace 30 s
  const st = startStream(s.url);
  await st.marker;
  const t0 = Date.now();
  s.child.kill('SIGTERM');
  await expect.poll(() => s.stderr()).toContain('draining, up to 30000 ms');
  s.child.kill('SIGTERM');
  expect(await s.exited).toBe(0);
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(s.stderr()).toContain('second signal');
  expect(await st.done).not.toContain('message_stop');
  expect(requestRecords(s.traces)[0]?.outcome.settledAtEstimate).toBe(true);

  const bad = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', 'http://127.0.0.1:1', '--no-metrics', '--shutdown-grace-ms', '-5']);
  let err = '';
  bad.stderr.on('data', (d: Buffer) => (err += d.toString()));
  expect(await new Promise((r) => bad.once('exit', r))).toBe(1);
  expect(err).toContain('--shutdown-grace-ms must be a whole number');
}, 30_000);
