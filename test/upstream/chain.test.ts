import { afterEach, beforeEach, expect, test } from 'vitest';
import { startAnthropicMock, type MockServer, type Scenario } from '../../src/mock/anthropic.js';
import type { CompiledPolicy, Plan } from '../../src/policy/types.js';
import { Breaker } from '../../src/upstream/breaker.js';
import { runChain, ChainError, workspaceOf, type ChainDeps } from '../../src/upstream/chain.js';
import type { ForwardRequest } from '../../src/upstream/forward.js';
import { RetryBudget } from '../../src/upstream/retry-budget.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

const status = (s: number, headers: Record<string, string> = {}, body = '{"type":"error","error":{"type":"x","message":"m"}}'): Scenario => ({ kind: 'status', status: s, headers, body });

let mocks: MockServer[] = [];
beforeEach(() => {
  process.env[PROVIDER_KEY_ENV] = 'sk-test';
});
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
  delete process.env[PROVIDER_KEY_ENV];
});

const body = Buffer.from('{"model":"claude-sonnet-5-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}');
const req: ForwardRequest = { method: 'POST', pathAndQuery: '/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body };

interface Rig {
  policy: CompiledPolicy;
  plan: (names: string[]) => Plan;
  deps: ChainDeps;
  now: { t: number };
  a: MockServer;
  b: MockServer;
  c: MockServer;
}

/** Three Anthropic providers a, b, c, each on its own mock; `routeEdit` can set route flags. */
async function rig(sc: { a?: Scenario; b?: Scenario; c?: Scenario } = {}, o: { fallbackOn429?: boolean; ratio?: number } = {}): Promise<Rig> {
  const a = await startAnthropicMock({ scenario: sc.a });
  const b = await startAnthropicMock({ scenario: sc.b });
  const c = await startAnthropicMock({ scenario: sc.c });
  mocks.push(a, b, c);
  const base = testPolicy({ upstream: a.url, editRoutes: (rs) => rs.forEach((r) => Object.assign(r, o.fallbackOn429 ? { fallbackOn429: true } : {})) });
  const spec = (name: string, url: string, env = PROVIDER_KEY_ENV) => [name, { name, format: 'anthropic' as const, baseUrl: url, credential: { env } }] as const;
  const policy: CompiledPolicy = { ...base, providers: new Map([spec('a', a.url), spec('b', b.url), spec('c', c.url), spec('other', b.url, 'OTHER_KEY_ENV')]) };
  const now = { t: 1_000_000 };
  const f = policy.failure.breaker;
  return {
    policy,
    now,
    a,
    b,
    c,
    plan: (names) => ({
      policyRevision: 'r',
      route: 'claude-code',
      chain: names.map((provider) => ({ provider, upstreamModel: 'claude-sonnet-5-5', rewritesModel: false })),
      reservations: [], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [],
    }),
    deps: { breaker: new Breaker(f, () => now.t), retry: new RetryBudget(o.ratio ?? policy.failure.retryBudgetRatio, () => now.t), tenant: 'acme', clock: () => now.t },
  };
}

function drop(res: { body: NodeJS.ReadableStream & { destroy(): unknown } }): void {
  res.body.on('error', () => undefined);
  res.body.destroy();
}

const run = (r: Rig, names: string[], signal = new AbortController().signal) => runChain(r.plan(names), r.policy, req, signal, r.deps);

test.each([500, 502, 503, 504, 529])('%i before headers falls back to the next provider', async (s) => {
  const r = await rig({ a: status(s) });
  const out = await run(r, ['a', 'b']);
  expect(out).toMatchObject({ attempt: 2, provider: 'b' });
  expect(out.response.status).toBe(200);
  drop(out.response);
  expect(r.a.received).toHaveLength(1);
  expect(r.b.received).toHaveLength(1);
  expect(r.b.received[0]?.body.equals(body)).toBe(true); // same bytes on every attempt
});

test('a connect error falls back to the next provider', async () => {
  const r = await rig();
  const dead = await startAnthropicMock();
  const url = dead.url;
  await dead.close();
  r.policy.providers.get('a');
  const policy: CompiledPolicy = { ...r.policy, providers: new Map([...r.policy.providers, ['a', { name: 'a', format: 'anthropic', baseUrl: url, credential: { env: PROVIDER_KEY_ENV } }]]) };
  const out = await runChain(r.plan(['a', 'b']), policy, req, new AbortController().signal, r.deps);
  expect(out).toMatchObject({ attempt: 2, provider: 'b' });
  drop(out.response);
});

test('when every attempt fails the last upstream response is returned unchanged', async () => {
  const r = await rig({ a: status(502), b: status(503, { 'x-up': '1' }, 'boom') });
  const out = await run(r, ['a', 'b']);
  expect(out).toMatchObject({ attempt: 2, provider: 'b' });
  expect(out.response.status).toBe(503);
  expect(out.response.headers['x-up']).toBe('1');
  const chunks: Buffer[] = [];
  for await (const c of out.response.body) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe('boom');
});

test('a chain that ends in connect errors throws ChainError with the attempt count', async () => {
  const r = await rig();
  const dead = await startAnthropicMock();
  const url = dead.url;
  await dead.close();
  const p = (name: string) => [name, { name, format: 'anthropic' as const, baseUrl: url, credential: { env: PROVIDER_KEY_ENV } }] as const;
  const policy: CompiledPolicy = { ...r.policy, providers: new Map([p('a'), p('b')]) };
  const err = await runChain(r.plan(['a', 'b']), policy, req, new AbortController().signal, r.deps).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChainError);
  expect((err as ChainError).attempts).toBe(2);
});

test('429 with retry-after is forwarded unchanged unless fallbackOn429', async () => {
  const r = await rig({ a: status(429, { 'retry-after': '3' }) });
  const out = await run(r, ['a', 'b']);
  expect(out).toMatchObject({ attempt: 1, provider: 'a' });
  expect(out.response.status).toBe(429);
  expect(out.response.headers['retry-after']).toBe('3');
  expect(r.b.received).toHaveLength(0);
  drop(out.response);

  const r2 = await rig({ a: status(429, { 'retry-after': '3' }) }, { fallbackOn429: true });
  const out2 = await run(r2, ['a', 'b']);
  expect(out2).toMatchObject({ attempt: 2, provider: 'b' });
  drop(out2.response);
});

test('spend-cap 429 opens that provider breaker for openSeconds and falls back', async () => {
  const cap = status(429, {}, '{"type":"error","error":{"type":"rate_limit_error","message":"enforced_spend_limit_reached"}}');
  const r = await rig({ a: cap });
  const out = await run(r, ['a', 'b']);
  expect(out).toMatchObject({ attempt: 2, provider: 'b' });
  drop(out.response);
  expect(r.deps.breaker.allow('a')).toBe(false);
  r.now.t += r.policy.failure.breaker.openSeconds * 1000 - 1;
  expect(r.deps.breaker.allow('a')).toBe(false);
  r.now.t += 1;
  expect(r.deps.breaker.allow('a')).toBe(true);
  // While open, the next request skips a without an attempt.
  r.deps.breaker.open('a', r.now.t + 5_000);
  const again = await run(r, ['a', 'b']);
  expect(again).toMatchObject({ attempt: 1, provider: 'b' });
  drop(again.response);
  expect(r.a.received).toHaveLength(1);
});

test('a spend-cap 429 on the last provider is forwarded with its body intact', async () => {
  const text = '{"type":"error","error":{"type":"rate_limit_error","message":"enforced_spend_limit_reached"}}';
  const r = await rig({ a: status(429, {}, text) });
  const out = await run(r, ['a']);
  expect(out.response.status).toBe(429);
  const chunks: Buffer[] = [];
  for await (const c of out.response.body) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe(text);
});

test.each([400, 401, 403, 404, 413, 422])('other 4xx (%i) is forwarded unchanged, no fallback', async (s) => {
  const r = await rig({ a: status(s) });
  const out = await run(r, ['a', 'b']);
  expect(out).toMatchObject({ attempt: 1, provider: 'a' });
  expect(out.response.status).toBe(s);
  expect(r.b.received).toHaveLength(0);
  drop(out.response);
});

test('never more than 3 attempts', async () => {
  const r = await rig({ a: status(500), b: status(500), c: status(500) }, { ratio: 1 });
  for (let i = 0; i < 5; i++) r.deps.retry.request('acme'); // room in the budget: only the attempt cap is under test
  const out = await run(r, ['a', 'b', 'c', 'a']);
  expect(out.attempt).toBe(3);
  expect(r.a.received.length + r.b.received.length + r.c.received.length).toBe(3);
  drop(out.response);
});

test('a client abort during an attempt aborts it and stops the chain', async () => {
  const r = await rig({ a: { kind: 'hangBeforeHeaders' } });
  const ac = new AbortController();
  const p = run(r, ['a', 'b'], ac.signal);
  await new Promise((res) => setTimeout(res, 50));
  ac.abort();
  await expect(p).rejects.toBeInstanceOf(ChainError);
  expect(r.b.received).toHaveLength(0);
});

test('retry budget of 10% stops fallback storms', async () => {
  const r = await rig({ a: status(503) });
  let fellBack = 0;
  let forwarded503 = 0;
  for (let i = 0; i < 20; i++) {
    const out = await run(r, ['a', 'b']);
    if (out.provider === 'b') fellBack++;
    else forwarded503++;
    drop(out.response);
  }
  // 20 requests: the floor of one retry, then at most 10% of the requests seen so far.
  expect(fellBack).toBeLessThanOrEqual(2);
  expect(fellBack).toBeGreaterThanOrEqual(1);
  expect(forwarded503).toBe(20 - fellBack);
  expect(r.b.received).toHaveLength(fellBack);
});

test('workspaceOf tells providers with another credential apart', async () => {
  const r = await rig();
  const w = (n: string) => workspaceOf(r.policy.providers.get(n) as NonNullable<ReturnType<typeof r.policy.providers.get>>);
  expect(w('a')).not.toBe(w('b')); // another endpoint
  expect(w('b')).not.toBe(w('other')); // same endpoint, another key: another workspace
  expect(w('a')).toBe(w('a'));
});
