// A3 (security review A): a client that aborts a stream after message_start and before the final message_delta is settled at
// input + ceil(streamed delta chars / 4) output tokens. Chars/4 is not a bound: summarized thinking (billed for the
// full thinking, streamed as a short summary), redacted thinking (no deltas at all) and text with more than one token
// per 4 chars (CJK, code symbols) are all billed above it. The client chooses when to abort, so it chooses the charge.
// Fix round 1 (controller ruling): input is not settled from message_start either, because with compaction or a
// server-tool loop most billed input arrives only in the final message_delta (usage.iterations). Any stream that ends
// without its final usage settles at the full reservation, as S20-2 does on Responses.
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

test('A3c a stream cut before message_delta settles at the full reservation', async () => {
  const { o } = await run([{ type: 'text_delta', text: 'hello' }], 0);
  expect(o.settledAtEstimate).toBe(true);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
  expect(o.reservedMicroUsd ?? 0).toBeGreaterThan(0);
});

test('A3d message_stop without any message_delta usage also settles at the full reservation', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 50, output_tokens: 1 } } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  const g = await gw(testPolicy({ upstream: up.url }));
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'x' }] }));
  await sendAndAbort(g.url, '/v1/messages', authHeaders, body, { until: (s) => s.includes('message_stop') });
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  expect(o.settledAtEstimate).toBe(true);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
});

/** A stream that sends message_start with the top-level count, some blocks, then hangs until the client goes. */
async function cutAfterStart(extraBody: Record<string, unknown>, headers: Record<string, string> = {}) {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 23_000, output_tokens: 1 } } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'summary' } }));
    res.write(': marker-sent\n\n');
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'Hello' }], ...extraBody }));
  await sendAndAbort(g.url, '/v1/messages', { ...authHeaders, ...headers }, body, { until: (s) => s.includes('marker-sent') });
  await expect.poll(() => g.outcomes.length).toBe(1);
  return { o: g.outcomes[0]!, policy };
}

test('A3e threshold compaction cut before message_delta: the compaction input (only in usage.iterations) is covered', async () => {
  const { o, policy } = await cutAfterStart({ context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 } }] } }, { 'anthropic-beta': 'compact-2026-01-12' });
  // A 900k-token compaction iteration plus the message iteration: what the provider may bill for the cut stream.
  const bill = costMicroUsd(policy.prices, MODEL, { input: 923_000, output: 3_500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  expect(o.settledAtEstimate).toBe(true);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(bill);
});

test('A3f server-tool loop cut before message_delta: the input of every iteration is covered', async () => {
  const { o, policy } = await cutAfterStart({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] });
  // Several sampling iterations over a large context: far above message_start's 23,000 input tokens.
  const bill = costMicroUsd(policy.prices, MODEL, { input: 3 * 900_000, output: 3 * 4_096, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  expect(o.settledAtEstimate).toBe(true);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
  expect(o.costMicroUsd ?? 0).toBeGreaterThanOrEqual(bill);
});
