// B2 fix round: the gateway asks upstream for `accept-encoding: identity`, but a provider (or a proxy before it) may
// still compress an error. Redaction cannot run on compressed bytes, so in API mode a non-2xx answer with a
// content-encoding other than identity is replaced by tokenyard's own error with the same status; a 2xx is untouched.
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';
import { closeAll, closers, raw, readJson } from './common.js';

afterEach(async () => {
  await closeAll();
  delete process.env[PROVIDER_KEY_ENV];
});

const key = `sk-ant-test-CANARY-${randomBytes(24).toString('hex')}`;

async function setup(status: number, encoding: string, body: Buffer) {
  process.env[PROVIDER_KEY_ENV] = key;
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(status, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': String(body.length) }).end(body);
  });
  const g = await startGateway({ policy: testPolicy({ upstream: up.url, openaiUpstream: up.url }) });
  closers.push(g.close);
  return g.url;
}

const echo = gzipSync(Buffer.from(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${key}` } })));

test('B2r a gzip-encoded 401 is replaced by an own error with the same status, in the Anthropic envelope', async () => {
  const url = await setup(401, 'gzip', echo);
  const r = await send(url, { path: '/v1/messages', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })) });
  expect(r.status).toBe(401);
  expect(r.headers['content-encoding']).toBeUndefined();
  expect(Number(r.headers['content-length'])).toBe(r.body.length);
  const e = JSON.parse(r.body.toString()) as { type: string; error: { type: string; message: string } };
  expect(e.type).toBe('error');
  expect(e.error.message).toMatch(/^tokenyard: upstream answered 401 with a gzip-encoded body/);
  expect(r.body.includes(echo)).toBe(false);
});

test('B2r on the Responses surface the own error uses the OpenAI envelope', async () => {
  const url = await setup(500, 'br', Buffer.from('compressed?'));
  const r = await send(url, { path: '/v1/responses', headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'hi', max_output_tokens: 16 })) });
  expect(r.status).toBe(500);
  const e = JSON.parse(r.body.toString()) as { error: { code: string; message: string } };
  expect(e.error.code).toBe('upstream_error_encoded');
});

test('B2r an identity-encoded error is still forwarded (redacted)', async () => {
  const url = await setup(401, 'identity', Buffer.from(`{"error":"${key}"}`));
  const r = await send(url, { path: '/v1/messages', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })) });
  expect(r.body.toString()).toBe('{"error":"[redacted]"}');
});
