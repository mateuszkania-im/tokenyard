// B2 and C6 (security reviews B and C): in API mode every client shares the operator's provider key, yet upstream
// answers went to the client verbatim: a 401 quoting the key it received (or its prefix and last four characters, as
// OpenAI does), and the account ids anthropic-organization-id, openai-organization and openai-project. The other way,
// a client's OpenAI-Organization / OpenAI-Project headers reached the provider and chose which organization or project
// the operator's key bills. Now non-2xx bodies up to 64 KiB have the configured credential and its masked forms
// replaced (content-length recomputed), the account headers are dropped both ways in API mode, and kept in passthrough.
import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { clientHeaders, upstreamHeaders } from '../../src/edge/headers.js';
import { redactCredentialEcho } from '../../src/guardrails/credential-echo.js';
import { send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';
import { closeAll, closers, raw, readJson } from './common.js';

afterEach(async () => {
  await closeAll();
  delete process.env[PROVIDER_KEY_ENV];
});

const rnd = (n: number): string => randomBytes(n).toString('hex').toUpperCase();
const msg = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
const auth = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };

type Reply = (h: IncomingHttpHeaders) => { status: number; headers: Record<string, string>; body: string };
async function setup(key: string, reply: Reply) {
  process.env[PROVIDER_KEY_ENV] = key;
  const seen: IncomingHttpHeaders[] = [];
  const up = await raw(async (req, res) => {
    await readJson(req);
    seen.push(req.headers);
    const r = reply(req.headers);
    res.writeHead(r.status, { ...r.headers, 'content-length': String(Buffer.byteLength(r.body)) }).end(r.body);
  });
  const g = await startGateway({ policy: testPolicy({ upstream: up.url, openaiUpstream: up.url }) });
  closers.push(g.close);
  return { url: g.url, seen };
}

test('B2a an upstream 401 quoting the provider key reaches the client with the key redacted and a matching content-length', async () => {
  const key = `sk-ant-test-CANARY-${rnd(24)}`;
  const s = await setup(key, (h) => ({ status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${String(h['x-api-key'])}` } }) }));
  const r = await send(s.url, { path: '/v1/messages', headers: auth, body: msg });
  expect(r.status).toBe(401);
  expect(r.body.toString()).not.toContain(key);
  expect(r.body.toString()).toContain('[redacted]');
  expect(Number(r.headers['content-length'])).toBe(r.body.length);
  expect((JSON.parse(r.body.toString()) as { error: { type: string } }).error.type).toBe('authentication_error');
});

test('B2b OpenAI-style "Incorrect API key provided: sk-proj-****WXYZ" is redacted', async () => {
  const key = `sk-proj-CANARY${rnd(24)}WXYZ`;
  const s = await setup(key, (h) => {
    const k = String(h.authorization ?? h['x-api-key'] ?? '').replace(/^Bearer /, '');
    const masked = `${k.slice(0, 8)}${'*'.repeat(Math.max(0, k.length - 12))}${k.slice(-4)}`;
    return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${masked}.`, type: 'invalid_request_error', code: 'invalid_api_key' } }) };
  });
  const r = await send(s.url, { path: '/v1/messages', headers: auth, body: msg });
  expect(r.body.toString()).not.toContain(`${key.slice(0, 8)}*`);
  expect(r.body.toString()).not.toContain('WXYZ');
});

test('B2b masked forms: prefix...last4, ****last4 and the full key are all replaced; short or unrelated text is not', () => {
  const key = `sk-ant-api03-${'a'.repeat(30)}Q7xZ`;
  for (const form of [key, `sk-ant-api03-aaa...Q7xZ`, `sk-...Q7xZ`, `****Q7xZ`, `sk-ant…Q7xZ`]) {
    expect(redactCredentialEcho(Buffer.from(`key ${form} rejected`), key)?.toString(), form).toBe('key [redacted] rejected');
  }
  expect(redactCredentialEcho(Buffer.from('nothing to see Q7xZ'), key)).toBeNull();
  expect(redactCredentialEcho(Buffer.from('k k k'), 'k')).toBeNull();
});

test('B2 a 2xx body is never touched, even when it quotes the key', async () => {
  const key = `sk-ant-test-CANARY-${rnd(24)}`;
  const body = JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: key }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  const s = await setup(key, () => ({ status: 200, headers: { 'content-type': 'application/json' }, body }));
  const r = await send(s.url, { path: '/v1/messages', headers: auth, body: msg });
  expect(r.body.toString()).toBe(body);
});

test('B2c upstream account headers do not reach the client in API mode', async () => {
  const s = await setup(`sk-ant-test-CANARY-${rnd(24)}`, () => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'anthropic-organization-id': 'CANARY-org', 'openai-organization': 'CANARY-org-openai', 'openai-project': 'CANARY-proj', 'request-id': 'req_1' },
    body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
  }));
  const r = await send(s.url, { path: '/v1/messages', headers: auth, body: msg });
  expect(Object.entries(r.headers).filter(([, v]) => String(v).includes('CANARY'))).toEqual([]);
  expect(r.headers['request-id']).toBe('req_1');
});

test('C6 client OpenAI-Organization / OpenAI-Project headers do not reach the upstream in API mode', async () => {
  const s = await setup(`sk-proj-CANARY${rnd(24)}`, () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: 'gpt-5.4-mini', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) }));
  await send(s.url, { path: '/v1/responses', headers: { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json', 'openai-organization': 'org-someone-else', 'openai-project': 'proj-someone-else' }, body: Buffer.from(JSON.stringify({ model: 'gpt-5.4-mini', input: 'hi', max_output_tokens: 16 })) });
  const h = s.seen.at(-1);
  expect(h).toBeDefined();
  expect([h?.['openai-organization'], h?.['openai-project']]).toEqual([undefined, undefined]);
});

test('B2c/C6 passthrough keeps the account headers both ways (the client is the account holder)', () => {
  const inbound = { 'openai-organization': 'o', 'openai-project': 'p', authorization: 'Bearer oauth' };
  const outUp = upstreamHeaders(inbound, { mode: 'passthrough', credential: null, host: 'api.anthropic.com' });
  expect([outUp['openai-organization'], outUp['openai-project']]).toEqual(['o', 'p']);
  const outClient = clientHeaders({ 'anthropic-organization-id': 'a', 'openai-project': 'p' }, {}, 'passthrough');
  expect([outClient['anthropic-organization-id'], outClient['openai-project']]).toEqual(['a', 'p']);
  expect(clientHeaders({ 'anthropic-organization-id': 'a' }, {}, 'api')['anthropic-organization-id']).toBeUndefined();
});

test('B2 an error body over 64 KiB has the key replaced in its first 64 KiB and the rest passed on, without a stale content-length', async () => {
  const key = `sk-ant-test-CANARY-${rnd(24)}`;
  const tail = 'x'.repeat(100_000);
  const s = await setup(key, () => ({ status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: `${key} ${tail}` } }) }));
  const r = await send(s.url, { path: '/v1/messages', headers: auth, body: msg });
  expect(r.status).toBe(500);
  expect(r.body.toString()).not.toContain(key);
  expect(r.body.toString()).toContain(tail);
  expect(r.headers['content-length']).toBeUndefined();
});
