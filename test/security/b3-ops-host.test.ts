// B3 / C5 (security reviews B and C): the token-less ops listener on loopback answered /metrics (tenant, team and route
// names, spend) for any Host header, so a web page in the operator's browser could read it through DNS rebinding.
// Without a metrics token, /metrics and /readyz are served only when Host names a loopback address or localhost;
// any other Host gets 421. With a token the bearer check decides, whatever the Host.
import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { startGateway } from '../helpers/gateway.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, closers } from './common.js';

afterEach(closeAll);

function get(base: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = request({ host: u.hostname, port: u.port, path, headers, setHost: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on('error', reject);
    r.end();
  });
}

async function ops(metricsToken?: string): Promise<string> {
  const g = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:1' }), opsListener: true, metrics: createMetrics(), ...(metricsToken ? { metricsToken } : {}) });
  closers.push(g.close);
  return g.opsUrl as string;
}

test('B3 /metrics and /readyz refuse a foreign Host with 421 when no token is set', async () => {
  const url = await ops();
  const port = new URL(url).port;
  for (const host of [`rebind.attacker.example:${port}`, 'attacker.example', `localhost.attacker.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
    expect(await get(url, '/metrics', { host }), host).toBe(421);
    expect(await get(url, '/readyz', { host }), host).toBe(421);
  }
  // No Host at all: node:http refuses the HTTP/1.1 request itself.
  expect(await get(url, '/metrics', {})).toBe(400);
  expect(await get(url, '/healthz', { host: 'attacker.example' })).toBe(200);
});

test('B3 loopback literals and localhost are served', async () => {
  const url = await ops();
  const port = new URL(url).port;
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost', `[::1]:${port}`, '127.0.0.2']) {
    expect(await get(url, '/metrics', { host }), host).toBe(200);
    expect(await get(url, '/readyz', { host }), host).toBe(200);
  }
});

test('B3 with a metrics token the bearer check decides, whatever the Host', async () => {
  const url = await ops('t0ken-for-the-test');
  expect(await get(url, '/metrics', { host: 'metrics.internal:9464', authorization: 'Bearer t0ken-for-the-test' })).toBe(200);
  expect(await get(url, '/metrics', { host: 'metrics.internal:9464' })).toBe(401);
});
