// A3 (security review A): a client that aborts a stream after message_start and before the final message_delta is settled at
// input + ceil(streamed delta chars / 4) output tokens. Chars/4 is not a bound: summarized thinking (billed for the
// full thinking, streamed as a short summary), redacted thinking (no deltas at all) and text with more than one token
// per 4 chars (CJK, code symbols) are all billed above it. The client chooses when to abort, so it chooses the charge.
import { afterEach, expect, test } from 'vitest';
import { authHeaders } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { closeAll, gw, raw, readJson, sendAndAbort, sse } from './common.js';

afterEach(closeAll);

const MODEL = 'claude-opus-5-5';

async function streamThenHang(deltas: Array<{ type: string; [k: string]: string }>) {
  return raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 50, output_tokens: 1 } } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: deltas[0]?.type === 'thinking_delta' ? 'thinking' : 'text' } }));
    for (const d of deltas) res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: d }));
    res.write(': marker-sent\n\n');
    // keeps generating (and billing) until the gateway goes away
  });
}

async function run(deltas: Array<{ type: string; [k: string]: string }>, billedOutput: number) {
  const up = await streamThenHang(deltas);
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 32_000, stream: true, thinking: { type: 'enabled', budget_tokens: 30_000 }, messages: [{ role: 'user', content: 'think hard' }] }));
  await sendAndAbort(g.url, '/v1/messages', authHeaders, body, { until: (s) => s.includes('marker-sent') });
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  const billed = costMicroUsd(policy.prices, MODEL, { input: 50, output: billedOutput, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  return { o, billed };
}

test('A3a abort during summarized thinking: 20,000 thinking tokens billed, a 400-char summary streamed', async () => {
  const { o, billed } = await run([{ type: 'thinking_delta', thinking: 'S'.repeat(400) }], 20_000);
  console.log(`A3a usageSource=${o.usage?.source} settledOutput=${o.usage?.usage?.output} charged=${o.costMicroUsd} providerBill=${billed} reserved=${o.reservedMicroUsd}`);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(billed);
});

test('A3b abort after 2,000 CJK characters of text (about one token per character)', async () => {
  const { o, billed } = await run([{ type: 'text_delta', text: '漢'.repeat(2000) }], 2000);
  console.log(`A3b usageSource=${o.usage?.source} settledOutput=${o.usage?.usage?.output} charged=${o.costMicroUsd} providerBill=${billed}`);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(billed);
});

test('A3c a stream cut before message_delta settles output at the reserved output bound, input from message_start', async () => {
  const { o } = await run([{ type: 'text_delta', text: 'hello' }], 0);
  const policy = testPolicy({ upstream: 'http://127.0.0.1:9' });
  // max_tokens 32,000 is the reserved output bound; input 50 comes from message_start.
  expect(o.usage?.usage?.output).toBe(32_000);
  expect(o.usage?.usage?.input).toBe(50);
  expect(o.costMicroUsd).toBe(costMicroUsd(policy.prices, MODEL, { input: 50, output: 32_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
  expect(o.costMicroUsd ?? 0).toBeLessThanOrEqual(o.reservedMicroUsd ?? 0);
});

test('A3d message_stop without any message_delta usage also settles output at the bound', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 50, output_tokens: 1 } } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'x' }] }));
  await sendAndAbort(g.url, '/v1/messages', authHeaders, body, { until: (s) => s.includes('message_stop') });
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.usage?.usage?.output).toBe(1000);
});
