// S21-1 (coordinator finding, Task 21, MEDIUM): /metrics was served unauthenticated on the API port and exposed
// per-tenant and per-team spend. It is never served on the API port; only the separate ops listener serves it
// (loopback by default, an admin bearer token when bound elsewhere). Health stays open on both.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { authHeaders, msgBody, send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { closeAll, closers } from './common.js';

const run = promisify(execFile);
afterEach(closeAll);

const get = (base: string, path: string, headers: Record<string, string> = {}) => send(base, { method: 'GET', path, headers });

async function stack(token?: string) {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await startGateway({ policy: testPolicy({ upstream: mock.url, models: ['claude-haiku-*'] }), store: createMemoryStore({ clock: Date.now }), metrics: createMetrics(), opsListener: true, ...(token ? { metricsToken: token } : {}) });
  closers.push(g.close);
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody() });
  return { api: g.url, ops: g.opsUrl as string };
}

test('S21-1 the API port answers 404 for /metrics once spend exists; the ops listener serves it', async () => {
  const { api, ops } = await stack();
  expect((await get(api, '/metrics')).status).toBe(404);
  expect((await get(api, '/metrics?x=1')).status).toBe(404);
  expect((await get(api, '/healthz')).status).toBe(200);
  const m = await get(ops, '/metrics');
  expect(m.status).toBe(200);
  expect(m.body.toString()).toContain('tokenyard_');
});

test('S21-1 with a token the ops listener refuses a missing, wrong or non-bearer credential and leaks no series', async () => {
  const { ops } = await stack('s3cret-token');
  const none = await get(ops, '/metrics');
  expect(none.status).toBe(401);
  expect(none.body.toString()).not.toContain('tokenyard_');
  expect((await get(ops, '/metrics', { authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await get(ops, '/metrics', { authorization: 'Basic s3cret-token' })).status).toBe(401);
  expect((await get(ops, '/metrics', { authorization: 'Bearer s3cret-token' })).status).toBe(200);
});

test('S21-1 serve refuses a non-loopback ops host without a metrics token', async () => {
  await expect(run('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', 'http://127.0.0.1:9', '--metrics-host', '0.0.0.0', '--metrics-port', '9464'], { env: { ...process.env, TOKENYARD_DEV_UPSTREAM_KEY: 'x', TOKENYARD_METRICS_TOKEN: '' } })).rejects.toMatchObject({
    stderr: expect.stringContaining('TOKENYARD_METRICS_TOKEN or --metrics-token-file'),
  });
});
