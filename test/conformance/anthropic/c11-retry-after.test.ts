import { afterEach, expect, test } from 'vitest';
import { anthropicError } from '../../../src/edge/errors.js';
import { authHeaders, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C11 tokenyard own retry-after is an integer number of seconds [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  // Fractional and edge inputs all come out as plain integers (no 1.5, no 1e-7, no negative).
  for (const [input, expected] of [[0.2, '1'], [1, '1'], [1.5, '2'], [59.01, '60'], [0, '0'], [-3, '0']] as const) {
    const e = anthropicError(429, 'rate_limit_error', 'slow down', input, 'req_1');
    expect(e.headers['retry-after'], String(input)).toBe(expected);
    expect(e.headers['retry-after']).toMatch(/^\d+$/);
  }
  expect(anthropicError(500, 'api_error', 'x', null, 'req_1').headers['retry-after']).toBeUndefined();
  // On the wire: a 429 carrying retry-after reaches the client as the same plain integer. The gateway's own 429s
  // (Task 14) are built by the same anthropicError, covered by the unit check above until then.
  stack = await startStack();
  stack.mock.setScenario({ kind: 'status', status: 429, headers: { 'retry-after': '3' }, body: '{"type":"error","error":{"type":"rate_limit_error","message":"x"}}' });
  const res = await send(stack.gw.url, { path: '/v1/messages', headers: authHeaders, body: '{}' });
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBe('3');
});
