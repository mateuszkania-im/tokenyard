// S12-1 (coordinator finding, Task 12, MEDIUM): the breaker was keyed by provider name only, so a spend-cap 429 or an
// auth error from ONE tenant's credential opened the provider-wide breaker for everybody (cross-tenant denial of
// service). Credential-scoped outcomes now open only a breaker keyed by provider plus credential identity (a hash of a
// forwarded token, never the token); the provider-health breaker counts 5xx, 529, connect errors and timeouts only.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startAnthropicMock, type MockServer, type Scenario } from '../../src/mock/anthropic.js';
import type { CompiledPolicy, Plan, ProviderSpec } from '../../src/policy/types.js';
import { Breaker } from '../../src/upstream/breaker.js';
import { credentialBreakerKey, runChain, type ChainDeps } from '../../src/upstream/chain.js';
import type { ForwardRequest } from '../../src/upstream/forward.js';
import { RetryBudget } from '../../src/upstream/retry-budget.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

const status = (s: number, body = '{"type":"error","error":{"type":"x","message":"m"}}'): Scenario => ({ kind: 'status', status: s, headers: {}, body });
const SPEND_CAP = '{"type":"error","error":{"type":"rate_limit_error","message":"enforced_spend_limit_reached"}}';
const body = Buffer.from('{"model":"claude-sonnet-5-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}');
const req: ForwardRequest = { method: 'POST', pathAndQuery: '/v1/messages', headers: { 'content-type': 'application/json' }, body };

const mocks: MockServer[] = [];
beforeEach(() => void (process.env[PROVIDER_KEY_ENV] = 'sk-test'));
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
  delete process.env[PROVIDER_KEY_ENV];
});

async function rig(sc: (token: string | undefined) => Scenario) {
  const a = await startAnthropicMock();
  const b = await startAnthropicMock();
  mocks.push(a, b);
  a.setScenario((rec) => sc([rec.headers.authorization].flat()[0]));
  const base = testPolicy({ upstream: a.url });
  const spec = (name: string, url: string, credential: ProviderSpec['credential']) => [name, { name, format: 'anthropic' as const, baseUrl: url, credential }] as const;
  const policy: CompiledPolicy = { ...base, providers: new Map([spec('a', a.url, 'passthrough'), spec('b', b.url, { env: PROVIDER_KEY_ENV })]) };
  const now = { t: 1_000_000 };
  const breaker = new Breaker(policy.failure.breaker, () => now.t);
  const plan: Plan = {
    id: 'req_1', policyRevision: 'r', route: 'claude-code',
    chain: ['a', 'b'].map((provider) => ({ provider, upstreamModel: 'claude-sonnet-5-5', rewritesModel: false })),
    reservations: [], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [],
  };
  const as = (token: string): ChainDeps => ({ breaker, retry: new RetryBudget(1, () => now.t), tenant: token, clock: () => now.t, headersFor: () => ({ authorization: `Bearer ${token}` }) });
  const run = async (token: string) => {
    const out = await runChain(plan, policy, req, new AbortController().signal, as(token));
    out.response.body.on('error', () => undefined);
    out.response.body.destroy();
    return out;
  };
  return { a, breaker, policy, run };
}

test('S12-1 one tenant spend-cap 429 skips only that credential; another tenant still reaches the provider', async () => {
  const r = await rig((t) => (t === 'Bearer A' ? status(429, SPEND_CAP) : { kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: 4 }));
  expect(await r.run('A')).toMatchObject({ provider: 'b' });
  expect(await r.run('B')).toMatchObject({ attempt: 1, provider: 'a' });
  expect(await r.run('A')).toMatchObject({ attempt: 1, provider: 'b' });
  expect(r.breaker.allow('a')).toBe(true);
});

test('S12-1 401 and 403 from one credential never open the provider breaker', async () => {
  for (const s of [401, 403]) {
    const r = await rig(() => status(s));
    for (let i = 0; i < 30; i++) await r.run('A');
    expect(r.breaker.allow('a')).toBe(true);
  }
});

test('S12-1 the credential breaker key differs per credential and never contains the credential', async () => {
  const r = await rig(() => status(200));
  const a = r.policy.providers.get('a') as ProviderSpec;
  const k1 = credentialBreakerKey(a, { authorization: 'Bearer secret-token-1' });
  expect(k1).not.toContain('secret-token-1');
  expect(k1).not.toBe(credentialBreakerKey(a, { authorization: 'Bearer secret-token-2' }));
});

test('S12-1 provider 5xx still opens the provider-wide breaker for everyone', async () => {
  const r = await rig(() => status(503));
  for (let i = 0; i < 30; i++) await r.run('A').catch(() => undefined);
  expect(r.breaker.allow('a')).toBe(false);
});
