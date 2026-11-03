// V3 chaos, scenario 2: clients that leave at random points and clients that stop reading. Ends with the shared
// invariants (test/chaos/harness.ts); the slow-consumer cases also check that the upstream is paused or aborted.
import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { chaosRequest, chatBody, checkInvariants, type ClientMode, type ClientResult, type Harness, headersFor, rng, startHarness } from './harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

test.each<[string, ClientMode]>([
  ['before the body is sent', { kind: 'abortBeforeBody' }],
  ['mid-upload', { kind: 'abortMidUpload' }],
  ['right after the response headers', { kind: 'abortAfterHeaders' }],
  ['mid-stream', { kind: 'abortAfterBytes', bytes: 300 }],
])('client leaves %s: one trace line, nothing held, charged at least what the provider billed', async (_, mode) => {
  h = await startHarness();
  h.setBehaviour(() => ({ kind: 'ok', stream: true, ttfbMs: 20, padEvents: 40, chunkDelayMs: 2 }));
  const sent = await Promise.all(Array.from({ length: 8 }, (_, i) => chaosRequest((h as Harness).url, `cl${mode.kind}${i}`, chatBody(`cl${mode.kind}${i}`, { padBytes: 20_000 }), mode)));
  await checkInvariants(h, sent);
  // Whatever reached a provider was stopped there too: no attempt is still writing.
  await expect.poll(() => (h as Harness).attempts.filter((a) => a.status === 200 && !a.closedEarly && a.bytesWritten === 0).length).toBe(0);
});

test('client leaves at random times across 120 requests with mixed upstream behaviour', async () => {
  h = await startHarness();
  const r = rng(Number(process.env.TOKENYARD_CHAOS_SEED ?? 11));
  const plan = new Map<string, number>();
  h.setBehaviour(({ chaosId, provider }) => {
    const x = plan.get(chaosId) ?? 0;
    if (x < 0.15 && provider === 'anthropic') return { kind: 'status', status: 529 };
    if (x < 0.25) return { kind: 'ok', stream: true, cutAt: 200 + Math.floor(x * 4000) };
    return { kind: 'ok', stream: x < 0.8, ttfbMs: Math.floor(x * 30), padEvents: 30, chunkDelayMs: 1 };
  });
  const modes: ClientMode[] = [{ kind: 'normal' }, { kind: 'abortBeforeBody' }, { kind: 'abortMidUpload' }, { kind: 'abortAfterHeaders' }, { kind: 'abortAfterBytes', bytes: 100 }];
  const sent = await Promise.all(
    Array.from({ length: 120 }, (_, i) => {
      const id = `mix${i}`;
      plan.set(id, r());
      const mode = r() < 0.3 ? { kind: 'abortAfterMs' as const, ms: Math.floor(r() * 60) } : (modes[Math.floor(r() * modes.length)] as ClientMode);
      return chaosRequest((h as Harness).url, id, chatBody(id, { stream: (plan.get(id) as number) < 0.8, padBytes: Math.floor(r() * 50_000) }), mode);
    }),
  );
  await checkInvariants(h, sent);
}, 30_000);

/** A streaming request whose reader stops after the first chunk; returns controls to resume or destroy it. */
function pausedReader(base: string, id: string): Promise<{ resume(): Promise<ClientResult>; destroy(): void; received(): number }> {
  return new Promise((resolve) => {
    const u = new URL(base);
    const body = chatBody(id);
    let bytes = 0;
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: { ...headersFor(id), 'content-length': String(body.length) } }, (res) => {
      res.once('data', (c: Buffer) => {
        bytes += c.length;
        res.pause();
        resolve({
          received: () => bytes,
          destroy: () => req.destroy(),
          resume: () =>
            new Promise((done) => {
              res.on('data', (d: Buffer) => (bytes += d.length));
              res.on('end', () => done({ chaosId: id, status: res.statusCode ?? 0, bytes, attempt: Number(res.headers['x-chaos-attempt']), error: null }));
              res.resume();
            }),
        });
      });
    });
    req.on('error', () => undefined);
    req.end(body);
  });
}

// 4,000 events of 16 KiB: a 64 MiB answer, far more than socket buffers and stream high-water marks hold.
const BIG = { kind: 'ok' as const, stream: true, padEvents: 4_000, padBytes: 16 * 1024 };

test('slow consumer: the upstream is paused by backpressure, gateway memory stays bounded, then the stream completes and settles', async () => {
  h = await startHarness();
  h.setBehaviour(() => BIG);
  const heapBefore = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const r = await pausedReader(h.url, 'slow1');
  await new Promise((x) => setTimeout(x, 500));
  const written = (h.attempts[0]?.bytesWritten ?? 0);
  await new Promise((x) => setTimeout(x, 300));
  // Paused: no progress while the reader does not read, and far less than the answer was written.
  expect(h.attempts[0]?.bytesWritten).toBe(written);
  expect(written).toBeLessThan(16 * 1024 * 1024);
  const grown = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - heapBefore;
  expect(grown).toBeLessThan(32 * 1024 * 1024);
  const done = await r.resume();
  expect(done.status).toBe(200);
  expect(done.bytes).toBeGreaterThan(60 * 1024 * 1024);
  await checkInvariants(h, [done]);
});

test('slow consumer that leaves while paused: the upstream is aborted and the request is charged at the reservation', async () => {
  h = await startHarness();
  h.setBehaviour(() => BIG);
  const r = await pausedReader(h.url, 'slow2');
  await new Promise((x) => setTimeout(x, 300));
  r.destroy();
  await expect.poll(() => h?.attempts[0]?.closedEarly).toBe(true);
  await checkInvariants(h, [{ chaosId: 'slow2', status: 200, bytes: r.received(), attempt: 1, error: null }]);
  const rec = h.records.find((x) => x.outcome.aborted);
  expect(rec?.outcome.chargedMicroUsd).toBe(rec?.decision.reservedMicroUsd);
});
