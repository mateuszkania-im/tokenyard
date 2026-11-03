// B1 (security review B): strings from the request body and the User-Agent were copied verbatim into trace records,
// OTel spans and --anonymize exports: a secret pasted into `model` (forwarded, the provider answers 404), prose or file
// paths in tools[].type and service_tier, an unbounded client version, a 200 kB model name as a 200 kB trace line.
// Every such field is bounded now: the model is kept only when the price table prices it (else "other"), a server tool
// type must match ^[a-z0-9_]{1,64}$ (else "(invalid)"), a service tier must be a known OpenAI tier (else "other"), the
// client version goes through the header sanitiser, and anonymizeRecord rebuilds every object field by field.
import { randomBytes } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { send } from '../helpers/conformance.js';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { clientAttributes, serverAttributes, type SpanSink } from '../../src/telemetry/otel.js';
import { TEST_KEY, testPolicy } from '../helpers/policy.js';
import { startGateway } from '../helpers/gateway.js';
import { closeAll, closers, raw, readJson } from './common.js';

afterEach(closeAll);

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const AWS_CANARY = `AKIA${'CANARY'}${'ABCDEFGHIJ'}`;
const PROSE_CANARY = 'CANARYPROSE-please-refactor-/home/alice/secret-project/src/billing.ts';
const auth = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
const codex = { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' };

async function setup(models?: string[]) {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', object: 'response', status: 'completed', role: 'assistant', model: 'claude-haiku-5-5', content: [], output: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
  });
  const traces: Rec[] = [];
  const spans: string[] = [];
  const sink: SpanSink = { requestSpan: (r) => void spans.push(JSON.stringify([serverAttributes(r), clientAttributes(r, null, true)])), shutdown: () => Promise.resolve() };
  const g = await startGateway({ policy: testPolicy({ upstream: up.url, openaiUpstream: up.url, ...(models ? { models } : {}) }), traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's', metrics: createMetrics(), spans: sink });
  closers.push(g.close);
  const last = async (): Promise<Rec> => {
    for (let i = 0; i < 100 && traces.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const r = traces.at(-1);
    if (!r) throw new Error('no trace');
    return r;
  };
  return { url: g.url, traces, spans, last };
}

const anon = (r: Rec): TraceRecord => anonymizeRecord({ ...r, instance: 'i', seq: 1 } as TraceRecord, saltedPseudonyms('x'));

test('B1a/B1b an unpriced model (a pasted secret) is traced and exported as "other", never in a span', async () => {
  const s = await setup();
  await send(s.url, { path: '/v1/messages', headers: auth, body: Buffer.from(JSON.stringify({ model: AWS_CANARY, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
  const rec = await s.last();
  expect(rec.features.model).toBe('other');
  expect(JSON.stringify(rec)).not.toContain('CANARY');
  expect(JSON.stringify(anon(rec))).not.toContain('CANARY');
  for (let i = 0; i < 50 && s.spans.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(s.spans.length).toBeGreaterThan(0);
  expect(s.spans.join('\n')).not.toContain('CANARY');
});

test('B1a a priced model is traced as sent', async () => {
  const s = await setup();
  await send(s.url, { path: '/v1/messages', headers: auth, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
  const rec = await s.last();
  expect(rec.features.model).toBe('claude-haiku-5-5');
  expect(rec.outcome.upstreamModel).toBe('claude-haiku-5-5');
});

test('B1a an unpriced model id an explicit allowModels pattern lists stays (replay needs it); an unlisted one is "other"', async () => {
  const s = await setup(['claude-haiku-*']);
  for (const [model, traced] of [['claude-haiku-9-9', 'claude-haiku-9-9'], ['claude-zzz-1', 'other'], [`claude-haiku-${AWS_CANARY}`, 'other']] as const) {
    s.traces.length = 0;
    await send(s.url, { path: '/v1/messages', headers: auth, body: Buffer.from(JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
    expect((await s.last()).features.model, model).toBe(traced);
  }
});

test('B1c a server tool type outside ^[a-z0-9_]{1,64}$ is traced as "(invalid)"', async () => {
  const s = await setup();
  await send(s.url, { path: '/v1/messages', headers: auth, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, tools: [{ type: PROSE_CANARY, name: 'x' }, { type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: 'hi' }] })) });
  const rec = await s.last();
  expect(rec.features.serverTools.map((t) => t.type)).toEqual(['(invalid)', 'web_search_20250305']);
  s.traces.length = 0;
  await send(s.url, { path: '/v1/responses', headers: codex, body: Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'hi', max_output_tokens: 16, tools: [{ type: `x${'y'.repeat(64)}` }] })) });
  expect((await s.last()).features.serverTools.map((t) => t.type)).toEqual(['(invalid)']);
});

test('B1e a Responses service_tier outside the known tiers is traced and exported as "other"', async () => {
  const s = await setup();
  const r = await send(s.url, { path: '/v1/responses', headers: codex, body: Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', service_tier: PROSE_CANARY, input: 'hi', max_output_tokens: 16 })) });
  const rec = await s.last();
  expect(r.status).not.toBe(200); // still refused (unpriced tier)
  expect(rec.features.serviceTier).toBe('other');
  expect(JSON.stringify(anon(rec))).not.toContain('CANARY');
});

test('B1f client.version is sanitised and capped at 128 printable ASCII characters', async () => {
  const s = await setup();
  await send(s.url, { path: '/v1/messages', headers: { ...auth, 'user-agent': `claude-cli/CANARY${'v'.repeat(6000)}` }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
  const rec = await s.last();
  expect(rec.client.agent).toBe('claude-code');
  expect(rec.client.version?.length ?? 0).toBeLessThanOrEqual(128);
});

test('B1d a 200 kB model name leaves a bounded trace line', async () => {
  const s = await setup();
  await send(s.url, { path: '/v1/messages', headers: auth, body: Buffer.from(JSON.stringify({ model: `CANARY${'m'.repeat(200_000)}`, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
  expect(JSON.stringify(await s.last()).length).toBeLessThan(16_384);
});

test('B1 anonymizeRecord rebuilds features and outcome field by field: unknown keys and free text never survive', () => {
  const canary = `CANARY-${randomBytes(6).toString('hex')}`;
  const r = {
    v: 1, kind: 'request', id: 'r1', ts: '2026-11-02T10:00:00.000Z', instance: 'i', seq: 1, tenant: 't', team: null, keyId: 'k', traffic: 'coding-agent', billing: 'api', surface: 'anthropic-messages',
    client: { agent: 'claude-code', version: canary, extra: canary },
    attribution: { session: null, agent: null, parentAgent: null, promptId: null, requestClass: null, agentType: null, repo: null, branch: null, ticket: null, feature: null },
    // An old trace written before the ingest bounds: free text in model, tool type and tier.
    features: { model: canary, stream: false, inputTokensBound: 1, boundKind: 'bytes', maxOutputTokens: 1, serverTools: [{ type: canary, maxUses: null, extra: canary }], toolCount: 0, thinking: false, bodyBytes: 1, prefixHash: null, contextCompacted: false, serviceTier: canary, extra: canary },
    guardrail: { hits: [] },
    policy: { revision: 'r' },
    decision: { route: null, action: 'forward', reason: null, chain: [], reservedMicroUsd: 0, boundAssumed: false, taintUnchecked: false, audit: [] },
    outcome: { provider: 'anthropic', upstreamModel: canary, attempts: 1, cacheColdRisk: false, status: 200, errorClass: null, midStreamError: canary, ttfbMs: 1, totalMs: 1, addedTtfbMs: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, extra: canary }, usageSource: 'final', costMicroUsd: 0, costBasis: 'billed', priceTable: 't', serviceTier: canary, rateLimitHeaders: { 'anthropic-ratelimit-unified-status': 'allowed', [`x-${canary}`]: canary }, aborted: false, settledBy: 'request', overrun: false, extra: canary },
    extra: canary,
  } as unknown as TraceRecord;
  const out = anonymizeRecord(r, saltedPseudonyms('x'));
  expect(JSON.stringify(out)).not.toContain('CANARY');
  expect(out.features.model).toBe('other');
  expect(out.features.serverTools).toEqual([{ type: '(invalid)', maxUses: null }]);
  expect(out.features.serviceTier).toBe('other');
  expect(out.outcome.usage).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  expect(out.outcome.rateLimitHeaders).toEqual({ 'anthropic-ratelimit-unified-status': 'allowed' });
});
