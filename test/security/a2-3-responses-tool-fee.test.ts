// A2-3 (security review A, second pass): on the Responses surface a priced server tool's per-call fee is reserved (max_tool_calls x perUseUsd) but never
// settled: parseResponsesJsonUsage / ResponsesUsageAccumulator never set `serverToolUses` (OpenAI reports the calls as
// `web_search_call` output items, not in `usage`), so actualCost() prices tokens only. OpenAI bills every web search
// call; the budget is charged none of them. The table also keyed tools by name only, so OpenAI web_search was priced
// with Anthropic's entry. Fix: server tool prices are per provider (`openai/web_search`), priced web_search_call items
// are counted (JSON output, stream output_item.done and terminal output), and a Responses request with a priced tool
// whose calls are not counted settles at its reservation.
import { afterEach, expect, it } from 'vitest';
import { codexHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { parseResponsesJsonUsage, ResponsesUsageAccumulator } from '../../src/stream/responses-usage.js';
import { closeAll, gw, raw, readJson, sse } from './common.js';

afterEach(closeAll);

it('A2-3 Responses web_search calls are reserved but not charged at settlement', async () => {
  const usage = { input_tokens: 1_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } };
  const up = await raw(async (req, res) => {
    await readJson(req);
    const output = [
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'web_search_call', id: `ws_${i}`, status: 'completed', action: { type: 'search', query: 'q' } })),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5.4-mini', output, usage }));
  });
  const policy = testPolicy({ upstream: up.url, editRoutes: (rs) => void (rs.find((r) => r.name === 'codex')!.serverTools = ['web_search']) });
  const { url, outcomes } = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'search the web', tools: [{ type: 'web_search' }], max_tool_calls: 5, max_output_tokens: 1000, stream: false }));
  const r = await send(url, { path: '/v1/responses', headers: { ...codexHeaders, accept: 'application/json' }, body });
  expect(r.status).toBe(200);
  const o = outcomes[0]!;
  const tokensOnly = costMicroUsd(policy.prices, 'gpt-5.4-mini', { input: 1_000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  const bill = costMicroUsd(policy.prices, 'gpt-5.4-mini', { input: 1_000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { serverToolUses: { web_search: 5 } });
  console.log(JSON.stringify({ reserved: o.reservedMicroUsd, charged: o.chargedMicroUsd, tokensOnly, billWithFiveCalls: bill }));
  expect(o.chargedMicroUsd!).toBeGreaterThanOrEqual(bill);
});

const usage = { input_tokens: 1_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } };
const call = (i: number) => ({ type: 'web_search_call', id: `ws_${i}`, status: 'completed', action: { type: 'search', query: 'q' } });
const body = Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'search the web', tools: [{ type: 'web_search' }], max_tool_calls: 5, max_output_tokens: 1000, stream: true }));

it('A2-3 a streamed response is charged every web_search_call it reports (output_item.done and the terminal output)', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('response.created', { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4-mini' } }));
    for (let i = 0; i < 3; i++) res.write(sse('response.output_item.done', { type: 'response.output_item.done', item: call(i) }));
    // The terminal output lists four calls: one more than the done events (never undercounted).
    res.end(sse('response.completed', { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.4-mini', status: 'completed', output: [0, 1, 2, 3].map(call), usage } }));
  });
  const policy = testPolicy({ upstream: up.url, editRoutes: (rs) => void (rs.find((r) => r.name === 'codex')!.serverTools = ['web_search']) });
  const { url, outcomes } = await gw(policy);
  const r = await send(url, { path: '/v1/responses', headers: codexHeaders, body });
  expect(r.status).toBe(200);
  await expect.poll(() => outcomes.length).toBe(1);
  const bill = costMicroUsd(policy.prices, 'gpt-5.4-mini', { input: 1_000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { serverToolUses: { web_search: 4 }, serverToolFormat: 'openai' });
  expect(outcomes[0]!.usage?.serverToolUses).toEqual({ web_search: 4 });
  expect(outcomes[0]!.chargedMicroUsd).toBe(bill);
});

it('A2-3 parsers count priced call items only', () => {
  const json = parseResponsesJsonUsage(Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', output: [call(0), call(1), { type: 'function_call', name: 'f' }, { type: 'message' }], usage })));
  expect(json.serverToolUses).toEqual({ web_search: 2 });
  const none = parseResponsesJsonUsage(Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', output: [{ type: 'function_call' }], usage })));
  expect(none.serverToolUses).toBeUndefined();
  const acc = new ResponsesUsageAccumulator();
  acc.onEvent({ event: 'response.output_item.done', data: JSON.stringify({ type: 'response.output_item.done', item: call(0) }) });
  acc.onEvent({ event: 'response.completed', data: JSON.stringify({ type: 'response.completed', response: { usage } }) });
  expect(acc.result().serverToolUses).toEqual({ web_search: 1 });
});

it('A2-3 an OpenAI tool is never priced with the Anthropic entry of the same name: refused under an enforced budget', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: 'gpt-5.4-mini', output: [], usage }));
  });
  const policy = testPolicy({
    upstream: up.url,
    editRoutes: (rs) => void (rs.find((r) => r.name === 'codex')!.serverTools = ['web_search']),
    editPrices: (p) => void delete p.serverTools['openai/web_search'],
  });
  expect(Object.hasOwn(policy.prices.serverTools, 'web_search')).toBe(true); // Anthropic's entry is still there
  const { url, outcomes } = await gw(policy);
  const r = await send(url, { path: '/v1/responses', headers: { ...codexHeaders, accept: 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'q', tools: [{ type: 'web_search' }], max_tool_calls: 5, max_output_tokens: 1000 })) });
  expect(r.status).toBe(403);
  await expect.poll(() => outcomes.length).toBe(1);
  expect(outcomes[0]!.decision?.reason).toBe('unpriced');
});

it('A2-3 a priced OpenAI tool whose calls are not counted settles at the reservation', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: 'gpt-5.4-mini', output: [{ type: 'file_search_call', id: 'fs_1' }], usage }));
  });
  const policy = testPolicy({
    upstream: up.url,
    editRoutes: (rs) => void (rs.find((r) => r.name === 'codex')!.serverTools = ['file_search']),
    editPrices: (p) => void (p.serverTools['openai/file_search'] = { perUseUsd: 0.0025, maxIterations: 1, source: 'test', retrieved: '2026-11-03' }),
  });
  const { url, outcomes } = await gw(policy);
  const r = await send(url, { path: '/v1/responses', headers: { ...codexHeaders, accept: 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'q', tools: [{ type: 'file_search', vector_store_ids: ['vs_1'] }], max_tool_calls: 2, max_output_tokens: 1000 })) });
  expect(r.status).toBe(200);
  await expect.poll(() => outcomes.length).toBe(1);
  const o = outcomes[0]!;
  expect(o.settledAtEstimate).toBe(true);
  expect(o.chargedMicroUsd).toBe(o.reservedMicroUsd);
});
