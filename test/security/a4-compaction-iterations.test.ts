// A4 (security review A): with server-side compaction (context_management edit compact_20260112, beta compact-2026-01-12) the provider runs a
// compaction sampling iteration inside the request. Anthropic's docs: "The top-level input_tokens and output_tokens do
// not include compaction iteration usage ... To calculate total tokens consumed and billed for a request, sum across all
// entries in the usage.iterations array." The gateway reads only the top-level fields, so it never charges the
// compaction iteration (here 180,000 input + 3,500 output tokens per compacting request).
import { afterEach, expect, test } from 'vitest';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { closeAll, gw, raw, readJson, sse } from './common.js';

afterEach(closeAll);

const MODEL = 'claude-opus-5-5';
// The documented example response (compaction-threshold page, "Understanding usage").
const usage = {
  input_tokens: 23_000,
  output_tokens: 1_000,
  iterations: [
    { type: 'compaction', input_tokens: 180_000, output_tokens: 3_500 },
    { type: 'message', input_tokens: 23_000, output_tokens: 1_000 },
  ],
};
const body = Buffer.from(
  JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: 'Hello, Claude' }], context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 } }] } }),
);
const headers = { ...authHeaders, 'anthropic-beta': 'compact-2026-01-12' };

test('A4a non-streaming: the compaction iteration is charged', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg', type: 'message', model: MODEL, content: [], usage }));
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers, body });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  const billed = costMicroUsd(policy.prices, MODEL, { input: 203_000, output: 4_500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  console.log(`A4a charged=${o.costMicroUsd} providerBill=${billed} reserved=${o.reservedMicroUsd}`);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(billed);
});

test('A4b streaming: the compaction iteration is charged', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 23_000, output_tokens: 1 } } }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers, body: Buffer.from(body.toString().replace('"max_tokens":4096', '"max_tokens":4096,"stream":true')) });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  const billed = costMicroUsd(policy.prices, MODEL, { input: 203_000, output: 4_500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  console.log(`A4b charged=${o.costMicroUsd} providerBill=${billed}`);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(billed);
});

test('A4c on-demand compaction: zero top-level usage, the summary call billed in usage.iterations', async () => {
  const onDemand = { input_tokens: 0, output_tokens: 0, iterations: [{ type: 'compaction', input_tokens: 144, output_tokens: 276 }] };
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg', type: 'message', model: MODEL, content: [], usage: onDemand }));
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const b = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 4096, compaction: {}, messages: [{ role: 'user', content: 'Hello' }] }));
  const r = await send(g.url, { path: '/v1/messages', headers: { ...authHeaders, 'anthropic-beta': 'compact-2026-09-04' }, body: b });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.costMicroUsd).toBe(costMicroUsd(policy.prices, MODEL, { input: 144, output: 276, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
});

test('A4d threshold compaction is reserved for a compaction iteration beside the message iteration', async () => {
  const policy = testPolicy({ upstream: 'http://127.0.0.1:9' });
  const { buildFeatures, decide } = await import('../../src/policy/decide.js');
  const { extractAnthropicFeatures } = await import('../../src/surfaces/anthropic-messages.js');
  const key = [...policy.keysByHash.values()][0]!;
  const attr = { session: null, agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null };
  const est = (b: Buffer): number => {
    const f = buildFeatures(extractAnthropicFeatures(b), key, attr, [], policy.prices, 'id', Date.UTC(2026, 10, 3), 'anthropic-messages');
    return decide(policy, f).reservations[0]?.estMicroUsd ?? 0;
  };
  const m = policy.prices.models[MODEL]!;
  const plain = est(Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 4096, metadata: { user_id: 'x' }, container: 'c', messages: [{ role: 'user', content: 'Hello, Claude' }] })));
  const compacting = est(body);
  // Same context-window input bound for both; compaction adds a whole iteration: the window again and a model-max summary.
  expect(compacting).toBeGreaterThanOrEqual(2 * plain - 1);
  expect(compacting - plain).toBeGreaterThanOrEqual(Math.floor((m.maxContextTokens * m.input + m.maxOutputTokens * m.output)));
  // The probe's documented bill fits under it.
  expect(compacting).toBeGreaterThanOrEqual(costMicroUsd(policy.prices, MODEL, { input: 203_000, output: 4_500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
});
