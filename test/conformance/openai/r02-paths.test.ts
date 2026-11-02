import { afterEach, expect, test } from 'vitest';
import { codexHeaders, respBody, send, startOpenAIStack } from '../../helpers/conformance.js';
import { startOpenAIMock, type OpenAIMockServer } from '../../../src/mock/openai.js';
import { startGateway, type TestGateway } from '../../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../../helpers/policy.js';

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let mock: OpenAIMockServer | undefined;
let gw: TestGateway | undefined;
afterEach(async () => {
  await stack?.close();
  await gw?.close();
  await mock?.close();
  stack = mock = gw = undefined;
  delete process.env[PROVIDER_KEY_ENV];
});

test('R2 /responses and /v1/responses both served [https://learn.chatgpt.com/docs/config-file/config-advanced]', async () => {
  // The provider's base URL carries /v1 (https://api.openai.com/v1); the gateway appends /responses to it.
  mock = await startOpenAIMock();
  stack = await startOpenAIStack({ policy: { openaiUpstream: `${mock.url}/v1` } });
  for (const path of ['/responses', '/v1/responses', '/v1/responses?client=x']) {
    const res = await send(stack.gw.url, { path, headers: codexHeaders, body: respBody() });
    expect(res.status, path).toBe(200);
    expect(mock.received.at(-1)?.pathAndQuery, path).toBe(path.endsWith('?client=x') ? '/v1/responses?client=x' : '/v1/responses');
  }
  expect(stack.mock.received).toHaveLength(0);
});

test('R2b a base path mount is stripped before /responses and /v1/responses [https://learn.chatgpt.com/docs/config-file/config-advanced]', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  mock = await startOpenAIMock();
  gw = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:9', openaiUpstream: mock.url }), basePath: '/llm' });
  for (const path of ['/llm/responses', '/llm/v1/responses']) {
    expect((await send(gw.url, { path, headers: codexHeaders, body: respBody() })).status, path).toBe(200);
    expect(mock.received.at(-1)?.pathAndQuery).toBe('/responses');
  }
  expect((await send(gw.url, { method: 'GET', path: '/llm/v1/responses', headers: codexHeaders })).status).toBe(404);
});
