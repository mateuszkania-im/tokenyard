import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { codexHeaders, PROVIDER_KEY, respBody, send, startOpenAIStack } from '../../helpers/conformance.js';
import { startOpenAIMock, type OpenAIMockServer } from '../../../src/mock/openai.js';
import { TEST_KEY } from '../../helpers/policy.js';

const dir = join(import.meta.dirname, '..', 'fixtures', 'openai');
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ name: f, bytes: readFileSync(join(dir, f)) }));

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let direct: OpenAIMockServer | undefined;
afterEach(async () => {
  await stack?.close();
  await direct?.close();
  stack = direct = undefined;
});

test('R1 body and header bytes equal, including encrypted reasoning items and unknown fields [https://developers.openai.com/api/docs/guides/reasoning]', async () => {
  stack = await startOpenAIStack();
  expect(fixtures.map((f) => f.name)).toEqual(['encrypted-reasoning.json', 'unknown-fields.json']);
  for (const f of fixtures) {
    const res = await send(stack.gw.url, { path: '/v1/responses', headers: { ...codexHeaders, 'x-unknown-header': 'kept as is' }, body: f.bytes });
    expect(res.status, f.name).toBe(200);
    const got = stack.mock.received.at(-1);
    expect(got?.body.equals(f.bytes), f.name).toBe(true);
    for (const h of ['originator', 'version', 'session_id', 'accept', 'user-agent', 'content-type', 'x-unknown-header'] as const) {
      expect(got?.headers[h], `${f.name} ${h}`).toBe({ ...codexHeaders, 'x-unknown-header': 'kept as is' }[h]);
    }
    // API mode: the ty_ key is replaced by the provider credential and never reaches upstream.
    expect(got?.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(JSON.stringify(got?.headers)).not.toContain(TEST_KEY);
  }
});

test('R1b SSE output bytes equal upstream bytes [https://developers.openai.com/api/reference/resources/responses/streaming-events]', async () => {
  direct = await startOpenAIMock();
  stack = await startOpenAIStack();
  const body = respBody();
  const want = await send(direct.url, { path: '/v1/responses', headers: codexHeaders, body });
  const got = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body });
  expect(got.status).toBe(200);
  expect(got.body.equals(want.body)).toBe(true);
  expect(got.body.toString()).toContain('event: response.completed');
  expect(got.headers['content-encoding']).toBeUndefined();
  expect(got.headers['x-accel-buffering']).toBe('no');
});
