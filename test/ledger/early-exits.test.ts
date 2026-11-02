import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { attachCandidate } from '../../src/policy/compile.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { startGateway } from '../helpers/gateway.js';
import { authHeaders, msgBody, send, startRawUpstream } from '../helpers/conformance.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function gateway(o: { upstream: string; routes?: boolean; bodyCapBytes?: number; models?: string[]; candidate?: CompiledPolicy }): Promise<{ url: string; records: Rec[] }> {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const records: Rec[] = [];
  const base = testPolicy({ upstream: o.upstream, models: o.models });
  const policy = o.candidate ? attachCandidate(base, o.candidate) : base;
  const gw = await startGateway({
    policy: o.routes === false ? { ...policy, routes: [] } : policy,
    bodyCapBytes: o.bodyCapBytes,
    traces: { write: (r) => (records.push(r), true) },
    traceSalt: 'salt',
  });
  closers.push(gw.close);
  return { url: gw.url, records };
}

test('403 no route: a block record with the reason, provider null, usage null', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gateway({ upstream: mock.url, routes: false });
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody() });
  expect(res.status).toBe(403);
  await expect.poll(() => g.records.length).toBe(1);
  expect(g.records[0]).toMatchObject({
    tenant: 'acme',
    decision: { action: 'block', reason: 'no-route', route: null },
    outcome: { status: 403, errorClass: 'permission_error', provider: null, usage: null, aborted: false, usageSource: 'none', costMicroUsd: null },
  });
});

test('403 model not allowed: answered before upstream, with a block record through the early-exit builder', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gateway({ upstream: mock.url, models: ['claude-opus-5-5*'] });
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-sonnet-5-5' }) });
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body.toString()).error.type).toBe('permission_error');
  expect(mock.received).toHaveLength(0);
  await expect.poll(() => g.records.length).toBe(1);
  expect(g.records[0]).toMatchObject({
    tenant: 'acme',
    features: { model: 'claude-sonnet-5-5', boundKind: 'bytes' },
    decision: { action: 'block', reason: 'model-not-allowed', route: 'claude-code' },
    outcome: { status: 403, errorClass: 'permission_error', provider: null, usage: null, usageSource: 'none' },
  });
  expect(g.records[0]?.features.inputTokensBound).toBeGreaterThan(0);
});

test('audit mode: the candidate policy decision is stored on the trace, the active one is enforced', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const strict = testPolicy({ upstream: mock.url, models: ['claude-opus-5-5*'] });
  const candidate = { ...strict, revision: 'cand', candidate: null };
  const g = await gateway({ upstream: mock.url, candidate });
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-sonnet-5-5' }) });
  expect(res.status).toBe(200);
  await expect.poll(() => g.records.length).toBe(1);
  expect(g.records[0]).toMatchObject({
    policy: { revision: 'test', candidateRevision: 'cand' },
    decision: { action: 'forward', route: 'claude-code' },
    candidateDecision: { action: 'block', reason: 'model-not-allowed', route: 'claude-code', chain: [] },
  });
});

test('413 body over the cap: a block record', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gateway({ upstream: mock.url, bodyCapBytes: 10 });
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody() });
  expect(res.status).toBe(413);
  await expect.poll(() => g.records.length).toBe(1);
  expect(g.records[0]).toMatchObject({
    decision: { action: 'block', reason: 'body-too-large' },
    outcome: { status: 413, errorClass: 'request_too_large', provider: null, usage: null },
  });
});

test('502 upstream unreachable: a forward record with errorClass and the provider name', async () => {
  const g = await gateway({ upstream: 'http://127.0.0.1:1' });
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody() });
  expect(res.status).toBe(502);
  await expect.poll(() => g.records.length).toBe(1);
  expect(g.records[0]).toMatchObject({
    decision: { action: 'forward', route: 'claude-code' },
    outcome: { status: 502, errorClass: 'upstream_unreachable', provider: 'anthropic', usage: null, aborted: false },
  });
});

test('client abort before upstream headers: an aborted record', async () => {
  let reached: () => void = () => undefined;
  const upstreamGotIt = new Promise<void>((r) => (reached = r));
  const up = await startRawUpstream((req) => {
    req.resume();
    reached(); // never answers
  });
  closers.push(up.close);
  const g = await gateway({ upstream: up.url });
  const u = new URL(g.url);
  const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders });
  req.on('error', () => undefined);
  req.end(msgBody());
  await upstreamGotIt;
  req.destroy();
  await expect.poll(() => g.records.length).toBe(1);
  expect(g.records[0]).toMatchObject({ outcome: { aborted: true, errorClass: 'client_abort', provider: 'anthropic', usage: null } });
});

test('401 before authentication is not recorded', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gateway({ upstream: mock.url });
  const res = await send(g.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-api-key': 'ty_live_nope' }, body: msgBody() });
  expect(res.status).toBe(401);
  await new Promise((r) => setTimeout(r, 50));
  expect(g.records).toEqual([]);
});
