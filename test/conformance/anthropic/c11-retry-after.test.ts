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
  // And on the wire for a tokenyard-originated error that exists today (the 429 paths arrive with Task 14, same builder).
  stack = await startStack({ policy: { upstream: 'http://127.0.0.1:1' } });
  const res = await send(stack.gw.url, { path: '/v1/messages', headers: authHeaders, body: '{}' });
  expect(res.status).toBe(502);
  const ra = res.headers['retry-after'];
  if (ra !== undefined) expect(ra).toMatch(/^\d+$/);
});
