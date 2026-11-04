// Shared by test/replay/settle-order.test.ts and test/security/s-v4-4-export-epoch.test.ts: two requests of one key
// with one stream slot through a real gateway, the second refused (streams) while the first holds the slot.
import { createGatewayRuntime } from '../../src/edge/handler.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { expect } from 'vitest';
import { authHeaders, send, startRawUpstream } from './conformance.js';
import { startGateway } from './gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from './policy.js';

export type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
/** Close these after each test (the upstream and the gateway of every `record()`). */
export const closers: Array<() => Promise<void>> = [];

export async function record(): Promise<{ policy: ReturnType<typeof testPolicy>; traces: Rec[] }> {
  process.env[PROVIDER_KEY_ENV] = 'k';
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  const up = await startRawUpstream((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString();
      seen.push(text);
      if (text.includes('holder')) await held;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  closers.push(up.close);
  const policy = testPolicy({ upstream: up.url, edit: (p) => void (p.rateLimits = [{ name: 'key-streams', scope: 'key', concurrentStreams: 1 }]) });
  const traces: Rec[] = [];
  const gw = await startGateway({ policy, store: createMemoryStore({ clock: Date.now }), traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's', runtime: createGatewayRuntime() });
  closers.push(gw.close);
  const body = (t: string): string => JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: t }] });
  const holder = send(gw.url, { path: '/v1/messages', headers: authHeaders, body: body('holder') });
  await expect.poll(() => seen.length).toBe(1);
  expect((await send(gw.url, { path: '/v1/messages', headers: authHeaders, body: body('second') })).status).toBe(429);
  release();
  expect((await holder).status).toBe(200);
  await expect.poll(() => traces.length).toBe(2);
  return { policy, traces };
}

export const lines = (traces: Rec[]): AsyncIterable<LedgerLine> =>
  (async function* () {
    yield* traces.map((t, i) => ({ ...t, instance: 'gw01', seq: i + 1 }));
  })();

