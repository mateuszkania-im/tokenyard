import { afterEach, expect, test } from 'vitest';
import { createMemoryStore } from '../../../src/limits/memory-store.js';
import { authHeaders, codexHeaders, msgBody, respBody, send, startOpenAIStack, type Sent } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

/** The OpenAI envelope: one `error` object with exactly type, code and a `tokenyard:` message, and the request id. */
function openaiEnvelope(res: Sent): { type: string; code: string; message: string } {
  const parsed = JSON.parse(res.body.toString()) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual(['error']);
  const e = parsed.error as Record<string, unknown>;
  expect(Object.keys(e).sort()).toEqual(['code', 'message', 'type']);
  expect(String(e.message)).toMatch(/^tokenyard: /);
  expect(res.headers['content-type']).toBe('application/json');
  expect(res.headers['x-tokenyard-request-id']).toMatch(/^req_/);
  return e as { type: string; code: string; message: string };
}

const AWS = 'AKIAIOSFODNN7EXAMPLE';

test('R6 own errors use the OpenAI envelope [https://developers.openai.com/api/docs/guides/error-codes]', async () => {
  stack = await startOpenAIStack({
    gw: { bodyCapBytes: 64 * 1024 },
    policy: {
      editRoutes: (routes) => {
        const codex = routes.find((r) => r.name === 'codex');
        if (codex) codex.allowModels = ['gpt-5.4*'];
      },
    },
  });
  const url = stack.gw.url;

  const unknownKey = await send(url, { path: '/v1/responses', headers: { ...codexHeaders, authorization: 'Bearer ty_live_nope' }, body: respBody() });
  expect(unknownKey.status).toBe(401);
  expect(openaiEnvelope(unknownKey)).toMatchObject({ type: 'invalid_request_error', code: 'invalid_api_key' });

  const model = await send(url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ model: 'gpt-5.5' }) });
  expect(model.status).toBe(403);
  expect(openaiEnvelope(model)).toMatchObject({ type: 'invalid_request_error', code: 'model_not_allowed' });
  expect(model.headers['x-should-retry']).toBe('false');

  // A built-in tool the route does not list is refused before any upstream call.
  const tool = await send(url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ tools: [{ type: 'web_search' }] }) });
  expect(tool.status).toBe(403);
  expect(openaiEnvelope(tool)).toMatchObject({ code: 'server_tool_not_allowed' });
  expect(tool.headers['x-should-retry']).toBe('false');

  // A secret in a tool output after the newest user message is in the last turn: blocked, never sent.
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read the config' }] },
    { type: 'function_call', name: 'shell', arguments: '{"command":["cat","cfg"]}', call_id: 'call_1' },
    { type: 'function_call_output', call_id: 'call_1', output: `aws_access_key_id = ${AWS}` },
  ];
  const secret = await send(url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ input }) });
  expect(secret.status).toBe(400);
  const se = openaiEnvelope(secret);
  expect(se).toMatchObject({ type: 'invalid_request_error', code: 'secret_detected' });
  expect(se.message).not.toContain(AWS);
  expect(secret.headers['x-should-retry']).toBe('false');

  const tooLarge = await send(url, { path: '/v1/responses', headers: codexHeaders, body: Buffer.alloc(65 * 1024, 0x20) });
  expect(tooLarge.status).toBe(413);
  expect(openaiEnvelope(tooLarge)).toMatchObject({ code: 'request_too_large' });

  expect(stack.mock.received).toHaveLength(0);

  // The Anthropic surface keeps the Anthropic envelope.
  const anth = await send(url, { path: '/v1/messages', headers: { ...authHeaders, 'x-api-key': 'ty_live_nope' }, body: msgBody() });
  expect(JSON.parse(anth.body.toString())).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
});

test('R6b budget and rate blocks: insufficient_quota without retry-after, rate limit with an integer retry-after [https://developers.openai.com/api/docs/guides/error-codes]', async () => {
  stack = await startOpenAIStack({
    policy: {
      edit: (p) => {
        p.budgets = [{ name: 'org-month', scope: 'tenant', window: 'month', usd: 0.01, onExceed: 'block', mode: 'enforce' }] as typeof p.budgets;
      },
    },
  });
  const budget = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody() });
  expect(budget.status).toBe(429);
  expect(openaiEnvelope(budget)).toMatchObject({ type: 'insufficient_quota', code: 'insufficient_quota' });
  expect(budget.headers['retry-after']).toBeUndefined();
  expect(budget.headers['x-should-retry']).toBe('false');
  await stack.close();

  stack = await startOpenAIStack({
    policy: {
      edit: (p) => {
        p.rateLimits = [{ name: 'one-rpm', scope: 'key', rpm: 1, burst: 1 }] as typeof p.rateLimits;
      },
    },
    gw: { store: createMemoryStore({ clock: Date.now }) },
  });
  expect((await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody() })).status).toBe(200);
  const rate = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody() });
  expect(rate.status).toBe(429);
  expect(openaiEnvelope(rate)).toMatchObject({ type: 'requests', code: 'rate_limit_exceeded' });
  expect(rate.headers['retry-after']).toMatch(/^\d+$/);
  expect(rate.headers['x-should-retry']).toBeUndefined();
});
