// V3 chaos, scenario 5: requests on reused keep-alive connections while the gateway is busy (V2 soak: 4 ECONNRESET on
// 1.1 MB requests on pooled sockets). Node closes an idle keep-alive socket when its timer fires (keepAliveTimeout plus
// Node's 1 s buffer). Timers run before the poll phase reads sockets, so when the event loop was blocked (a large body
// scanned inside an I/O callback) across that moment, a request the client already sent on the idle socket is still
// unread: the socket is destroyed with bytes in its receive buffer, and the kernel answers RST (ECONNRESET at the
// client). Clients run in worker threads with their own event loops, as separate client processes would. The fix:
// closeIdleWhenQuiet in src/edge/server.ts.
import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';
import type { Socket } from 'node:net';
import { closeIdleWhenQuiet } from '../../src/edge/server.js';
import { authHeaders, msgBody, startStack } from '../helpers/conformance.js';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const KEEP_ALIVE_MS = 300;
const CLOSES_AT_MS = KEEP_ALIVE_MS + 1_000; // Node acts 1 s after the advertised timeout

/**
 * One raw keep-alive connection from a worker: request 1, then request 2 on the same socket `sendAtMs` after the first
 * answer. At `blockAtMs` the worker asks the main thread (the gateway) to block its event loop for `blockMs` inside a
 * message callback, an I/O callback like the request handler that scans a large body. Resolves with what the client saw.
 */
function twoRequestsOnOneSocket(port: number, o: { blockAtMs: number; blockMs: number; sendAtMs: number }): Promise<string[]> {
  const body = msgBody();
  const head = `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\n${Object.entries(authHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('')}content-length: ${body.length}\r\n\r\n`;
  const w = new Worker(
    `
const { workerData: d, parentPort } = require('node:worker_threads');
const net = require('node:net');
const s = net.connect(d.port, '127.0.0.1');
const req = Buffer.concat([Buffer.from(d.head), Buffer.from(d.body)]);
let n = 0;
let buf = '';
s.on('data', (c) => {
  buf += c.toString('latin1');
  // One answer is complete once its body is in: by content-length, or the last chunk of a chunked body.
  const end = buf.indexOf('\\r\\n\\r\\n');
  if (end < 0) return;
  const m = /content-length: (\\d+)/i.exec(buf.slice(0, end));
  if (m ? buf.length < end + 4 + Number(m[1]) : !buf.endsWith('\\r\\n0\\r\\n\\r\\n')) return;
  const status = buf.slice(9, 12);
  buf = '';
  n++;
  parentPort.postMessage('answer ' + status);
  if (n === 1) {
    setTimeout(() => parentPort.postMessage('block'), d.blockAtMs);
    setTimeout(() => s.write(req), d.sendAtMs);
  } else s.end();
});
s.on('error', (e) => parentPort.postMessage('error ' + e.code));
s.on('close', () => parentPort.postMessage('close'));
s.write(req);
`,
    { eval: true, workerData: { port, head, body: body.toString('latin1'), ...o } },
  );
  const seen: string[] = [];
  return new Promise((resolve) => {
    w.on('message', (m: string) => {
      if (m === 'block') {
        const t0 = Date.now();
        while (Date.now() - t0 < o.blockMs);
        return;
      }
      if (m === 'close') {
        void w.terminate().then(() => resolve(seen));
        return;
      }
      seen.push(m);
    });
  });
}

test('a request sent on an idle keep-alive socket while the gateway is blocked across its idle close is answered, not reset', async () => {
  const stack = await startStack({ gw: { keepAliveTimeoutMs: KEEP_ALIVE_MS } });
  close = stack.close;
  const port = Number(new URL(stack.gw.url).port);
  // Blocked from 100 ms before the close to 150 ms after it; the second request goes out 20 ms after the close.
  const seen = await twoRequestsOnOneSocket(port, { blockAtMs: CLOSES_AT_MS - 100, blockMs: 250, sendAtMs: CLOSES_AT_MS + 20 });
  expect(seen).toEqual(['answer 200', 'answer 200']);
});

test('an idle keep-alive socket is still closed after the timeout when nothing arrives', async () => {
  const stack = await startStack({ gw: { keepAliveTimeoutMs: KEEP_ALIVE_MS } });
  close = stack.close;
  const port = Number(new URL(stack.gw.url).port);
  const t0 = Date.now();
  // The second request is never sent in time: the server closes the idle socket.
  const seen = await twoRequestsOnOneSocket(port, { blockAtMs: 60_000, blockMs: 0, sendAtMs: 60_000 });
  expect(seen).toEqual(['answer 200']);
  expect(Date.now() - t0).toBeLessThan(CLOSES_AT_MS + 1_000);
});

/** A stand-in socket: only what closeIdleWhenQuiet reads. */
const fakeSocket = (): Socket & { closedAt: number | null } => {
  const s = { bytesRead: 100, destroyed: false, closedAt: null as number | null, destroy() {
    s.destroyed = true;
    s.closedAt = Date.now();
  } };
  return s as unknown as Socket & { closedAt: number | null };
};

test('idle close on a quiet loop happens at once', async () => {
  const s = fakeSocket();
  closeIdleWhenQuiet(s);
  await expect.poll(() => s.destroyed).toBe(true);
});

test('idle close on a loop that stays busy is retried, and forced after 2 s of loop time', async () => {
  const s = fakeSocket();
  let t = 0;
  // Every reading of the clock is 60 ms later: no turn of the loop is ever quiet.
  closeIdleWhenQuiet(s, () => (t += 60));
  await new Promise((r) => setTimeout(r, 100));
  expect(s.destroyed).toBe(false);
  await expect.poll(() => s.destroyed, { timeout: 3_000 }).toBe(true);
  expect(t).toBeGreaterThanOrEqual(2_000);
});

test('bytes read after the idle timer fired cancel the close', async () => {
  const s = fakeSocket();
  let t = 0;
  closeIdleWhenQuiet(s, () => (t += 60));
  (s as { bytesRead: number }).bytesRead += 10; // a request arrived
  await new Promise((r) => setTimeout(r, 300));
  expect(s.destroyed).toBe(false);
});

/**
 * Under load (opt-in, `npm run test:chaos`): 1.1 MB requests keep the gateway busy scanning while 16 probe connections
 * each send a small request, stay idle for about the idle close time (jittered), and send again on the same socket.
 * Clients are worker threads with Node's keep-alive Agent, as the V2 soak client was. `roles` puts the heavy senders and
 * the probes in separate workers (`['heavy', 'probe']`) or in one (`['both']`), where the busy client itself is slow to
 * notice a close. Counts what each probe and heavy request saw.
 */
type LoadResult = { sent: number; ok: number; errors: Record<string, number> };
async function loadRun(url: string, o: { seconds: number; closeAtMs: number; roles: Array<'heavy' | 'probe' | 'both'> }): Promise<LoadResult> {
  const runs = o.roles.map(async (role) => {
    const w = new Worker(
      `
const { workerData: d, parentPort } = require('node:worker_threads');
const http = require('node:http');
const u = new URL(d.url);
const heavyText = 'export const x = "a\\\\"b";\\n'.repeat(Math.ceil(1_100_000 / 24)).slice(0, 1_100_000);
const body = (text) => Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: text }] }));
const heavy = body(heavyText);
const small = body('hi');
const out = { sent: 0, ok: 0, errors: {} };
const send = (agent, b) => new Promise((resolve) => {
  out.sent++;
  const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', agent, headers: { ...d.headers, 'content-length': String(b.length) } }, (res) => {
    res.resume();
    res.on('end', () => { if (res.statusCode === 200) out.ok++; else out.errors['status ' + res.statusCode] = (out.errors['status ' + res.statusCode] || 0) + 1; resolve(); });
  });
  req.on('error', (e) => { const k = (e.code || 'error') + (req.reusedSocket ? ' on a reused socket' : ''); out.errors[k] = (out.errors[k] || 0) + 1; resolve(); });
  req.end(b);
});
const until = Date.now() + d.seconds * 1000;
const heavyLoop = async () => { const a = new http.Agent({ keepAlive: true, maxSockets: 1 }); while (Date.now() < until) await send(a, heavy); a.destroy(); };
const probe = async () => {
  const a = new http.Agent({ keepAlive: true, maxSockets: 1 });
  while (Date.now() < until) {
    await send(a, small);
    await new Promise((r) => setTimeout(r, d.closeAtMs - 80 + Math.random() * 160));
  }
  a.destroy();
};
const loops = [];
if (d.role !== 'probe') loops.push(heavyLoop(), heavyLoop(), heavyLoop());
if (d.role !== 'heavy') for (let i = 0; i < 16; i++) loops.push(probe());
Promise.all(loops).then(() => parentPort.postMessage(out));
`,
      { eval: true, workerData: { url, headers: authHeaders, seconds: o.seconds, closeAtMs: o.closeAtMs, role } },
    );
    const out = await new Promise<LoadResult>((resolve) => w.once('message', resolve));
    await w.terminate();
    return out;
  });
  const all = await Promise.all(runs);
  const total: LoadResult = { sent: 0, ok: 0, errors: {} };
  for (const r of all) {
    total.sent += r.sent;
    total.ok += r.ok;
    for (const [k, v] of Object.entries(r.errors)) total.errors[k] = (total.errors[k] ?? 0) + v;
  }
  return total;
}

const SECONDS = Number(process.env.TOKENYARD_CHAOS_KA_SECONDS ?? 40);

test.skipIf(!process.env.TOKENYARD_CHAOS)('under load: a busy gateway resets no request sent on a reused keep-alive socket (client not busy)', async () => {
  // 2 s, not 300 ms: Node's Agent reads the `Keep-Alive: timeout=N` hint in whole seconds and keeps no socket below 2.
  const stack = await startStack({ gw: { keepAliveTimeoutMs: 2_000 } });
  close = stack.close;
  const r = await loadRun(stack.gw.url, { seconds: SECONDS, closeAtMs: 3_000, roles: ['heavy', 'probe'] });
  console.log(`keep-alive under load, separate client workers: ${JSON.stringify(r)}`);
  expect(r.errors).toEqual({});
  expect(r.ok).toBe(r.sent);
}, 180_000);

test.skipIf(!process.env.TOKENYARD_CHAOS)('under load, heavy senders and probes in one busy client (as the V2 soak client): no resets', async () => {
  const stack = await startStack({ gw: { keepAliveTimeoutMs: 2_000 } });
  close = stack.close;
  const r = await loadRun(stack.gw.url, { seconds: SECONDS, closeAtMs: 3_000, roles: ['both'] });
  console.log(`keep-alive under load, one busy client worker: ${JSON.stringify(r)}`);
  expect(r.errors).toEqual({});
  expect(r.ok).toBe(r.sent);
}, 180_000);
