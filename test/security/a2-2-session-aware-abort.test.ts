// A2-2 (security review A, second pass): A3's fix settles a Messages stream without its final usage at the reservation. Under
// `reservation.estimator: session-aware` the reservation prices one sampling iteration and no server tool fees
// (estimator.ts sessionAwareMicroUsd), so a client that drops the connection right before message_delta, after a
// web search loop ran, is charged one iteration instead of what the provider billed. The same stream run to the end
// is charged its full cost (overrun debited), so the abort is a client-chosen discount on every request.
// Fix: decide keeps the worst-case estimate on the plan whatever the estimator, and a request without final usage
// settles at max(reservation, worst case); replay charges the same.
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { atEstimateCharge } from '../../src/policy/admission.js';
import { closeAll, gw, raw, readJson, sendAndAbort, sse } from './common.js';

afterEach(closeAll);

const MODEL = 'claude-haiku-5-5';
const iterations = Array.from({ length: 10 }, () => ({ input_tokens: 900_000, output_tokens: 400 }));
const finalUsage = { input_tokens: 500_000, output_tokens: 4_000, server_tool_use: { web_search_requests: 5 }, iterations };

function stream(res: ServerResponse, finish: boolean): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: 500_000, output_tokens: 1 } } }));
  for (let i = 0; i < 5; i++) {
    res.write(sse('content_block_start', { type: 'content_block_start', index: 2 * i, content_block: { type: 'server_tool_use', id: `srv_${i}`, name: 'web_search', input: {} } }));
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 2 * i }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 2 * i + 1, content_block: { type: 'web_search_tool_result', tool_use_id: `srv_${i}`, content: [] } }));
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 2 * i + 1 }));
  }
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 10, delta: { type: 'text_delta', text: 'SEARCH_DONE' } }));
  if (!finish) return; // the provider has done (and billed) the whole loop; message_delta is the next event
  res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: finalUsage }));
  res.end(sse('message_stop', { type: 'message_stop' }));
}

it('A2-2 session-aware: aborting before message_delta settles one iteration instead of the billed loop', async () => {
  let finish = true;
  const up = await raw(async (req, res) => {
    await readJson(req);
    stream(res, finish);
  });
  const policy = testPolicy({ upstream: up.url, edit: (p) => void (p.reservation = { ...p.reservation, estimator: 'session-aware' }) });
  const { url, outcomes } = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }], messages: [{ role: 'user', content: 'search' }] }));
  const bill = costMicroUsd(policy.prices, MODEL, { input: 9_000_000, output: 4_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { serverToolUses: { web_search: 5 } });

  const full = await send(url, { path: '/v1/messages', headers: authHeaders, body });
  expect(full.status).toBe(200);
  await expect.poll(() => outcomes.length).toBe(1);

  finish = false;
  await sendAndAbort(url, '/v1/messages', authHeaders, body, { until: (s) => s.includes('SEARCH_DONE') });
  await expect.poll(() => outcomes.length).toBe(2);
  const [done, cut] = outcomes as [(typeof outcomes)[0], (typeof outcomes)[0]];
  console.log(JSON.stringify({ bill, completed: { reserved: done.reservedMicroUsd, charged: done.chargedMicroUsd }, aborted: { reserved: cut.reservedMicroUsd, charged: cut.chargedMicroUsd, settledAtEstimate: cut.settledAtEstimate } }));
  expect(done.chargedMicroUsd!).toBeGreaterThanOrEqual(bill); // held: a finished stream is charged what it cost
  expect(cut.chargedMicroUsd!).toBeGreaterThanOrEqual(bill); // bypass: the aborted one is charged far less
});

it('A2-2 the charge without final usage is the higher of the reservation and the worst case, only with budget levels', () => {
  const plan = { reservations: [{ estMicroUsd: 10 }], worstCaseMicroUsd: 500 } as unknown as Parameters<typeof atEstimateCharge>[0];
  expect(atEstimateCharge(plan, 10)).toBe(500);
  expect(atEstimateCharge({ ...plan!, worstCaseMicroUsd: 5 }, 10)).toBe(10);
  expect(atEstimateCharge({ ...plan!, reservations: [] }, 0)).toBe(0);
  expect(atEstimateCharge(null, 7)).toBe(7);
});
