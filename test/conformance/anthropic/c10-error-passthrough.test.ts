import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

test('C10 upstream error status, body bytes, retry-after, x-should-retry and anthropic-ratelimit-unified-* unchanged for 400, 401, 413, 429, 500, 529 [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  for (const [code, type] of Object.entries(TYPES)) {
    const status = Number(code);
    const body = `{"type":"error","error":{"type":"${type}","message":"upstream ${code} \\u00e9"},"request_id":"req_up_${code}"}`;
    const headers = {
      'retry-after': '17',
      'x-should-retry': status >= 500 || status === 429 ? 'true' : 'false',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1767225600',
      'anthropic-ratelimit-unified-5h-utilization': '0.93',
      'request-id': `req_up_${code}`,
    };
    stack.mock.setScenario({ kind: 'status', status, headers, body });
    const res = await send(stack.gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody() });
    expect(res.status).toBe(status);
    expect(res.body.equals(Buffer.from(body)), code).toBe(true);
    for (const [k, v] of Object.entries(headers)) expect(res.headers[k], `${code} ${k}`).toBe(v);
  }
});
