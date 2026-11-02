import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { startGateway } from '../helpers/gateway.js';
import { authHeaders, msgBody, send, startRawUpstream } from '../helpers/conformance.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function gateway(o: { upstream: string; routes?: boolean; bodyCapBytes?: number }): Promise<{ url: string; records: Rec[] }> {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const records: Rec[] = [];
  const policy = testPolicy({ upstream: o.upstream });
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
    tenant: 'dev',
    decision: { action: 'block', reason: 'no-route', route: null },
    outcome: { status: 403, errorClass: 'permission_error', provider: null, usage: null, aborted: false, usageSource: 'none', costMicroUsd: null },
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
    decision: { action: 'forward', route: 'dev' },
    outcome: { status: 502, errorClass: 'upstream_unreachable', provider: 'dev-upstream', usage: null, aborted: false },
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
  expect(g.records[0]).toMatchObject({ outcome: { aborted: true, errorClass: 'client_abort', provider: 'dev-upstream', usage: null } });
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
