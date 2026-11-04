// A5 and C7 (security reviews A and C): every body-derived control (model allowlist, server-tool denial, unpriced
// service tier, iteration and fee bounds, max_tokens) rests on the gateway's own JSON.parse of the bytes it forwards
// unchanged. A provider whose parser accepts what JSON.parse rejects (a UTF-8 BOM, a gzip Content-Encoding the gateway
// never decodes) or keeps the first of two duplicate keys sees another request than the one priced and authorised.
// Such bodies are refused with 400 in the gateway's own envelope and x-should-retry: false; a body JSON.parse rejects
// is forwarded (so the provider answers its own 400) only when no enforced budget level applies.
import { gzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { authHeaders, codexHeaders, respBody, send } from '../helpers/conformance.js';
import { auditBudgets, testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson } from './common.js';

afterEach(closeAll);

async function upstream(log: Buffer[]) {
  return raw(async (req, res) => {
    const { raw: body } = await readJson(req);
    log.push(body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'r', type: 'message', object: 'response', model: 'claude-opus-5-5', status: 'completed', content: [], output: [], usage: { input_tokens: 10, output_tokens: 10 } }));
  });
}

function expectRefused(r: { status: number; headers: Record<string, unknown>; body: Buffer }, envelope: 'anthropic' | 'openai', what: string): void {
  expect(r.status, what).toBe(400);
  expect(r.headers['x-should-retry'], what).toBe('false');
  const e = JSON.parse(r.body.toString()) as { type?: string; error: { type: string } };
  if (envelope === 'anthropic') expect(e.type, what).toBe('error');
  expect(e.error.type, what).toBe('invalid_request_error');
}

const hidden = respBody({ model: 'gpt-5.4', stream: false, service_tier: 'priority', tools: [{ type: 'web_search' }, { type: 'code_interpreter', container: { type: 'auto' } }] });

test('A5a a UTF-8 BOM before the body is refused, never forwarded', async () => {
  const log: Buffer[] = [];
  const up = await upstream(log);
  const g = await gw(testPolicy({ upstream: up.url, openaiUpstream: up.url }));
  const r1 = await send(g.url, { path: '/v1/responses', headers: codexHeaders, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), hidden]) });
  expectRefused(r1, 'openai', 'responses');
  const msg = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }));
  const r2 = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), msg]) });
  expectRefused(r2, 'anthropic', 'messages');
  expect(log).toHaveLength(0);
});

test('A5b a non-identity Content-Encoding is refused, never forwarded opaque; identity is accepted', async () => {
  const log: Buffer[] = [];
  const up = await upstream(log);
  const g = await gw(testPolicy({ upstream: up.url, openaiUpstream: up.url }));
  for (const ce of ['gzip', 'br', 'deflate, identity', 'x-unknown']) {
    const r = await send(g.url, { path: '/v1/responses', headers: { ...codexHeaders, 'content-encoding': ce }, body: gzipSync(hidden) });
    expectRefused(r, 'openai', ce);
  }
  expect(log).toHaveLength(0);
  const ok = await send(g.url, { path: '/v1/responses', headers: { ...codexHeaders, 'content-encoding': 'Identity' }, body: respBody({ model: 'gpt-5.4', stream: false }) });
  expect(ok.status).toBe(200);
});

test('A5c, C7 duplicate keys are refused: top level, and inside a tools entry', async () => {
  const log: Buffer[] = [];
  const up = await upstream(log);
  const g = await gw(testPolicy({ upstream: up.url, openaiUpstream: up.url }));
  const messages = [
    // C7: opus first, haiku second; JSON.parse reads haiku.
    '{"model":"claude-opus-5-5","model":"claude-haiku-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}',
    // An empty second tools key hides web_search.
    '{"model":"claude-opus-5-5","max_tokens":10,"tools":[{"type":"web_search_20250305","name":"web_search"}],"tools":[],"messages":[{"role":"user","content":"hi"}]}',
    // A5c: a duplicate type inside one tool.
    '{"model":"claude-opus-5-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20250305","name":"web_search","type":"custom","input_schema":{"type":"object"}}]}',
    // A5c: max_tokens read as 1 by JSON.parse, 128000 by a first-wins parser.
    '{"model":"claude-opus-5-5","max_tokens":128000,"max_tokens":1,"messages":[{"role":"user","content":"hi"}]}',
    // An escaped duplicate is the same key.
    '{"model":"claude-opus-5-5","max_tokens":10,"\\u0073tream":false,"stream":true,"messages":[{"role":"user","content":"hi"}]}',
  ];
  for (const body of messages) expectRefused(await send(g.url, { path: '/v1/messages', headers: authHeaders, body }), 'anthropic', body);
  const responses = [
    '{"model":"gpt-5.4","model":"gpt-5.4-nano","input":"hi"}',
    '{"model":"gpt-5.4","input":"hi","service_tier":"priority","service_tier":"default"}',
    '{"model":"gpt-5.4","input":"hi","tools":[{"type":"namespace","name":"n","tools":[{"type":"web_search","type":"function","name":"f"}]}]}',
  ];
  for (const body of responses) expectRefused(await send(g.url, { path: '/v1/responses', headers: codexHeaders, body }), 'openai', body);
  expect(log).toHaveLength(0);
});

test('A5d an unparsable body is refused under an enforced budget, forwarded unchanged without one', async () => {
  const log: Buffer[] = [];
  const up = await upstream(log);
  const broken = '{"model":"claude-opus-5-5", "messages": [ {"role":"user",';
  const enforced = await gw(testPolicy({ upstream: up.url }));
  expectRefused(await send(enforced.url, { path: '/v1/messages', headers: authHeaders, body: broken }), 'anthropic', 'enforced');
  expect(log).toHaveLength(0);
  const audit = await gw(testPolicy({ upstream: up.url, edit: auditBudgets }));
  await send(audit.url, { path: '/v1/messages', headers: authHeaders, body: broken });
  expect(log.map((b) => b.toString())).toEqual([broken]);
});
