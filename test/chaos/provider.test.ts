// V3 chaos, scenario 1: provider failures. Each case drives the real gateway through a scripted upstream and ends with
// the shared invariants (test/chaos/harness.ts).
import { afterEach, expect, test } from 'vitest';
import { type Behaviour, chaosRequest, chatBody, checkInvariants, type ClientResult, type Harness, rng, sseMessage, startHarness } from './harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const run = (n: number, prefix: string, o: { stream?: boolean } = {}): Promise<ClientResult[]> =>
  Promise.all(Array.from({ length: n }, (_, i) => chaosRequest((h as Harness).url, `${prefix}${i}`, chatBody(`${prefix}${i}`, o))));

test.each([500, 502, 503, 529])('provider %i before headers: falls back to the backup before any byte, settled at the actual cost', async (status) => {
  h = await startHarness();
  h.setBehaviour(({ provider }) => (provider === 'anthropic' ? { kind: 'status', status } : { kind: 'ok' }));
  const sent = await run(10, `s${status}x`);
  expect(sent.map((s) => s.status)).toEqual(Array(10).fill(200));
  expect(sent.every((s) => s.attempt === 2)).toBe(true);
  await checkInvariants(h, sent);
});

test('retry budget at the example 10%: fallbacks beyond it are not tried, the 5xx reaches the client, nothing held', async () => {
  h = await startHarness({ edit: (p) => void (p.failure = { ...p.failure, retryBudgetRatio: 0.1 }) });
  h.setBehaviour(({ provider }) => (provider === 'anthropic' ? { kind: 'status', status: 503 } : { kind: 'ok' }));
  const sent = await run(10, 'rbudget');
  const ok = sent.filter((s) => s.status === 200).length;
  expect(ok).toBeGreaterThanOrEqual(1);
  expect(sent.filter((s) => s.status === 503).length).toBe(10 - ok);
  await checkInvariants(h, sent);
});

test('every provider answers 5xx: the last answer reaches the client unchanged, nothing billed, nothing held', async () => {
  h = await startHarness();
  h.setBehaviour(() => ({ kind: 'status', status: 503 }));
  const sent = await run(6, 'all5xx');
  expect(sent.map((s) => s.status)).toEqual(Array(6).fill(503));
  await checkInvariants(h, sent);
});

test.each([false, true])('drop right after 200 headers (stream %s): no fallback, charged at the reservation', async (stream) => {
  h = await startHarness();
  h.setBehaviour(() => ({ kind: 'ok', stream, cutAfterHeaders: true }));
  const sent = await run(8, `hdrdrop${String(stream)}`, { stream });
  expect(sent.every((s) => s.status === 200 && s.attempt === 1)).toBe(true);
  expect(h.attempts.every((a) => a.provider === 'anthropic')).toBe(true);
  await checkInvariants(h, sent);
  for (const r of h.records.filter((x) => x.decision.reservedMicroUsd > 0 && x.outcome.provider !== null)) {
    if (r.outcome.status === 200 && r.attribution.session !== null) expect(r.outcome.chargedMicroUsd).toBe(r.decision.reservedMicroUsd);
  }
});

test('mid-stream drops at random byte offsets: the client gets exactly the bytes sent, never a second provider', async () => {
  h = await startHarness();
  const total = sseMessage({ input: 10, output: 40 }).join('').length;
  const r = rng(7);
  const cuts = new Map<string, number>();
  h.setBehaviour(({ chaosId }) => {
    if (!cuts.has(chaosId)) cuts.set(chaosId, 1 + Math.floor(r() * (total - 1)));
    return { kind: 'ok', stream: true, cutAt: cuts.get(chaosId) as number } satisfies Behaviour;
  });
  const sent = await run(40, 'mid');
  expect(sent.every((s) => s.status === 200 && s.attempt === 1)).toBe(true);
  for (const s of sent) expect(s.bytes).toBeLessThanOrEqual(cuts.get(s.chaosId) as number);
  await checkInvariants(h, sent);
});

test('slow headers past the request deadline: 504, aborted upstream, charged at the reservation', async () => {
  h = await startHarness({ requestDeadlineMs: 300 });
  h.setBehaviour(() => ({ kind: 'hang' }));
  const sent = await run(5, 'slowhdr');
  expect(sent.map((s) => s.status)).toEqual(Array(5).fill(504));
  await expect.poll(() => h?.attempts.filter((a) => a.closedEarly).length).toBe(5);
  await checkInvariants(h, sent);
  for (const r of h.records) if (r.decision.reservedMicroUsd > 0) expect(r.outcome.chargedMicroUsd).toBe(r.decision.reservedMicroUsd);
});

test('a stream past the request deadline is cut and charged at the reservation', async () => {
  h = await startHarness({ requestDeadlineMs: 300 });
  h.setBehaviour(() => ({ kind: 'ok', stream: true, padEvents: 60, chunkDelayMs: 20 }));
  const sent = await run(3, 'slowbody');
  expect(sent.every((s) => s.status === 200)).toBe(true);
  await checkInvariants(h, sent);
  for (const r of h.records) if (r.decision.reservedMicroUsd > 0) expect(r.outcome.chargedMicroUsd).toBe(r.decision.reservedMicroUsd);
});

test('connection refused on the primary: free fallback to the backup', async () => {
  h = await startHarness({ primaryUrl: 'http://127.0.0.1:9' });
  const sent = await run(8, 'refused');
  expect(sent.every((s) => s.status === 200 && s.attempt === 1)).toBe(true);
  await checkInvariants(h, sent);
  for (const r of h.records) if (r.outcome.status === 200) expect(r.outcome.attempts).toBe(2);
});

test('DNS failure on the primary (.invalid host): free fallback to the backup', async () => {
  h = await startHarness({ primaryUrl: 'http://tokenyard-chaos.invalid:1' });
  const sent = await run(4, 'dns');
  expect(sent.every((s) => s.status === 200)).toBe(true);
  await checkInvariants(h, sent);
});

test('both providers unreachable: 502, settled at 0, nothing held', async () => {
  h = await startHarness({ primaryUrl: 'http://127.0.0.1:9', backupUrl: 'http://127.0.0.1:9' });
  const sent = await run(5, 'unreach');
  expect(sent.map((s) => s.status)).toEqual(Array(5).fill(502));
  await checkInvariants(h, sent);
  for (const r of h.records) expect(r.outcome.chargedMicroUsd ?? 0).toBe(0);
});

test('TLS-like reset (socket destroyed once the request arrived): no fallback, charged at the reservation', async () => {
  h = await startHarness();
  h.setBehaviour(() => ({ kind: 'reset' }));
  const sent = await run(6, 'reset');
  expect(sent.map((s) => s.status)).toEqual(Array(6).fill(502));
  expect(h.attempts.every((a) => a.provider === 'anthropic')).toBe(true);
  await checkInvariants(h, sent);
  for (const r of h.records) if (r.decision.reservedMicroUsd > 0) expect(r.outcome.chargedMicroUsd).toBe(r.decision.reservedMicroUsd);
});

test('breaker: provider 5xx past the ratio opens the provider breaker; requests go to the backup without touching it', async () => {
  h = await startHarness({ edit: (p) => void (p.failure = { ...p.failure, breaker: { minRequests: 4, failureRatio: 0.5, windowSeconds: 30, openSeconds: 30 }, retryBudgetRatio: 1 }) });
  h.setBehaviour(({ provider }) => (provider === 'anthropic' ? { kind: 'status', status: 529 } : { kind: 'ok' }));
  const first: ClientResult[] = [];
  for (let i = 0; i < 4; i++) first.push(await chaosRequest(h.url, `brk${i}`, chatBody(`brk${i}`)));
  const before = h.attempts.filter((a) => a.provider === 'anthropic').length;
  expect(before).toBe(4);
  const second: ClientResult[] = [];
  for (let i = 4; i < 10; i++) second.push(await chaosRequest(h.url, `brk${i}`, chatBody(`brk${i}`)));
  expect(h.attempts.filter((a) => a.provider === 'anthropic').length).toBe(before);
  expect([...first, ...second].every((s) => s.status === 200)).toBe(true);
  await checkInvariants(h, [...first, ...second]);
});

test('breaker: a spend-cap 429 opens the breaker for that credential only, not for the provider', async () => {
  h = await startHarness({ edit: (p) => void (p.failure = { ...p.failure, retryBudgetRatio: 1 }) });
  // The primary credential is capped; the backup has its own credential env name on the same upstream origin.
  let capped = 0;
  h.primary.server.removeAllListeners('request');
  h.primary.server.on('request', (req, res) => {
    req.resume();
    req.on('end', () => {
      capped++;
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'enforced_spend_limit_reached' } }));
    });
  });
  const sent: ClientResult[] = [];
  for (let i = 0; i < 5; i++) sent.push(await chaosRequest(h.url, `cap${i}`, chatBody(`cap${i}`)));
  expect(sent.every((s) => s.status === 200)).toBe(true);
  expect(capped).toBe(1); // the credential breaker skipped the capped one from the second request on
  await checkInvariants(h, sent);
});
