// A6 (security review A): the gateway settles at 0 every request whose upstream attempt failed before response headers, on the premise
// that "nothing came back, so nothing was billed". That holds for connect errors only. After the body is delivered
// the provider may have generated (and billed) the whole answer: a non-streaming request sends headers only when
// generation ends, so a client that aborts just before then, or a headers timeout / connection reset on a long
// generation, is charged 0. Each such attempt is also retried on the next provider in the chain, which bills again,
// while one reservation and one usage are counted.
import { afterEach, expect, test } from 'vitest';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, sendAndAbort } from './common.js';

afterEach(closeAll);

const MODEL = 'claude-opus-5-5';
const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: 'user', content: 'write 64k tokens' }] }));

test('A6a client aborts a non-streaming request while the provider generates: charged at least the estimate', async () => {
  let generating = 0;
  const up = await raw(async (req) => {
    await readJson(req);
    generating++; // the provider has the whole request and is generating; headers come when it is done
  });
  const g = await gw(testPolicy({ upstream: up.url }));
  await sendAndAbort(g.url, '/v1/messages', authHeaders, body, { afterMs: 300 });
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  console.log(`A6a upstreamReceived=${generating} status=${o.status} reserved=${o.reservedMicroUsd} charged=${o.costMicroUsd}`);
  expect(generating).toBe(1);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(o.reservedMicroUsd ?? 1);
});

test('A6b upstream drops the connection after receiving the body: no fallback to the backup, charged at the reservation', async () => {
  let n = 0;
  const up = await raw(async (req, res) => {
    await readJson(req);
    if (++n === 1) {
      setTimeout(() => res.socket?.destroy(), 200); // provider 1 worked on it, then the connection died before headers
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: MODEL, content: [], usage: { input_tokens: 30, output_tokens: 64_000 } }));
  });
  const g = await gw(testPolicy({ upstream: up.url }));
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  // The first provider had the whole request and may bill it: a second provider would bill it again under one reservation.
  expect(n).toBe(1);
  expect(o.attempts).toBe(1);
  expect(r.status).toBe(502);
  expect(o.settledAtEstimate).toBe(true);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
  expect(o.reservedMicroUsd ?? 0).toBeGreaterThan(0);
});

test('A6c every attempt drops after the body: the request is charged, not settled at 0', async () => {
  let n = 0;
  const up = await raw(async (req, res) => {
    await readJson(req);
    n++;
    setTimeout(() => res.socket?.destroy(), 100);
  });
  const g = await gw(testPolicy({ upstream: up.url }));
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  console.log(`A6c status=${r.status} upstreamRequests=${n} reserved=${o.reservedMicroUsd} charged=${o.costMicroUsd}`);
  expect(o.costMicroUsd ?? 0).toBeGreaterThan(0);
});

test('A6d a connect-phase error (nothing written upstream) still falls back, and the failed attempt is free', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: MODEL, content: [], usage: { input_tokens: 30, output_tokens: 10 } }));
  });
  const policy = testPolicy({ upstream: up.url, edit: (p) => void (p.providers.anthropic!.baseUrl = 'http://127.0.0.1:9') });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  expect(o.attempts).toBe(2);
  expect(o.settledAtEstimate).toBeUndefined();
  expect(o.costMicroUsd).toBeLessThan(o.reservedMicroUsd ?? 0);
});

test('A6e every provider refuses the connection: 502, settled at 0', async () => {
  const policy = testPolicy({ upstream: 'http://127.0.0.1:9' });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(r.status).toBe(502);
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.costMicroUsd).toBe(0);
});
