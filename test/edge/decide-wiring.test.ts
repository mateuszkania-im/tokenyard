import { afterEach, expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { startAnthropicMock, type MockServer } from '../../src/mock/anthropic.js';
import { startGateway } from '../helpers/gateway.js';
import { authHeaders, msgBody, send } from '../helpers/conformance.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

async function stack(o: Omit<Parameters<typeof testPolicy>[0], 'upstream'>): Promise<{ url: string; mock: MockServer; records: Rec[] }> {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const records: Rec[] = [];
  const gw = await startGateway({ policy: testPolicy({ upstream: mock.url, ...o }), traces: { write: (r) => (records.push(r), true) }, traceSalt: 's' });
  closers.push(gw.close);
  return { url: gw.url, mock, records };
}

test('rewriteModel: upstream gets the served model, every other byte identical', async () => {
  const s = await stack({ rewriteModel: 'claude-haiku-5-5' });
  const raw = '{ "max_tokens": 64,\n "metadata": {"model": "inner"},\n "model" :  "claude-opus-5-5" , "messages":[{"role":"user","content":"\\"model\\": x"}] }';
  const res = await send(s.url, { path: '/v1/messages', headers: authHeaders, body: raw });
  expect(res.status).toBe(200);
  expect(s.mock.received[0]?.body.toString('utf8')).toBe(raw.replace('"claude-opus-5-5"', '"claude-haiku-5-5"'));
  expect(s.mock.received[0]?.headers['content-length']).toBe(String(Buffer.byteLength(raw) + 1));
});

test('rewriteModel: a model that cannot be located exactly blocks the request before upstream', async () => {
  const s = await stack({ rewriteModel: 'claude-haiku-5-5' });
  const raw = '{"model":"claude-opus-5-5","max_tokens":64,"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}]}';
  const res = await send(s.url, { path: '/v1/messages', headers: authHeaders, body: raw });
  expect(res.status).toBe(400);
  expect(JSON.parse(res.body.toString()).error).toMatchObject({ type: 'invalid_request_error' });
  expect(s.mock.received).toHaveLength(0);
  await expect.poll(() => s.records.length).toBe(1);
  expect(s.records[0]).toMatchObject({ decision: { action: 'block', reason: 'model-rewrite-failed', route: 'claude-code' }, outcome: { status: 400, provider: null } });
});

test('a client request-class header cannot reach a route with wider allowModels', async () => {
  const s = await stack({
    models: ['claude-haiku-*'],
    editRoutes: (routes) => routes.unshift({ name: 'compaction', match: { requestClass: 'compaction' }, chain: ['anthropic'], allowModels: ['claude-*'] }),
  });
  const headers = { ...authHeaders, 'x-claude-code-request-class': 'compaction' };
  const refused = await send(s.url, { path: '/v1/messages', headers, body: msgBody({ model: 'claude-opus-5-5' }) });
  expect(refused.status).toBe(403);
  expect(JSON.parse(refused.body.toString()).error.type).toBe('permission_error');
  const allowed = await send(s.url, { path: '/v1/messages', headers, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(allowed.status).toBe(200);
  expect(s.mock.received).toHaveLength(1);
});
