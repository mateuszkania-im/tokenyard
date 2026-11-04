// Shared bits for the test/security regression tests (security review A, Task 25). Mock upstreams only.
import { request } from 'node:http';
import { hashKey } from '../../src/edge/auth.js';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { CompiledPolicy, KeyRecord } from '../../src/policy/types.js';
import { startRawUpstream } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';

export const closers: Array<() => Promise<void>> = [];
export async function closeAll(): Promise<void> {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
}

export const SERVICE_KEY = 'ty_live_service_probe';
export const serviceKey: KeyRecord = { hash: hashKey(SERVICE_KEY), keyId: 'key_svc', tenant: 'acme', team: 'web', name: 'svc', kind: 'service', billing: 'api' };

export async function raw(handler: Parameters<typeof startRawUpstream>[0]) {
  const up = await startRawUpstream(handler);
  closers.push(up.close);
  return up;
}

export async function gw(policy: CompiledPolicy, store: CounterStore = createMemoryStore({ clock: Date.now }), extra: Partial<Parameters<typeof startGateway>[0]> = {}) {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const outcomes: RequestOutcome[] = [];
  const g = await startGateway({ policy, store, onSettled: (o) => outcomes.push(o), ...extra });
  closers.push(g.close);
  return { url: g.url, outcomes, store };
}

export const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function readJson(req: import('node:http').IncomingMessage): Promise<{ raw: Buffer; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((r) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => r({ raw: Buffer.concat(chunks), headers: req.headers }));
  });
}

/** POST and destroy the client socket once `until(text so far)` is true, or after `afterMs`. */
export function sendAndAbort(base: string, path: string, headers: Record<string, string>, body: Buffer, o: { until?: (s: string) => boolean; afterMs?: number }): Promise<void> {
  return new Promise((done) => {
    const u = new URL(base);
    let seen = '';
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path, headers }, (res) => {
      res.on('data', (c: Buffer) => {
        seen += c.toString();
        if (o.until?.(seen)) {
          req.destroy();
          done();
        }
      });
    });
    req.on('error', () => undefined);
    req.end(body);
    if (o.afterMs !== undefined) setTimeout(() => (req.destroy(), done()), o.afterMs);
  });
}
