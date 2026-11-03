// V4 property: replay fidelity (spec 9.2 step 5). Any mix of requests (four keys on three teams, allowed, refused and
// unpriced models, sessions, a secret in the last turn and the same secret in a later history, expensive answers
// against a small team budget, slow answers holding the one stream slot, count_tokens), sent in waves whose requests
// race each other, is traced by the real gateway; replaying those traces under the policy that recorded them
// reproduces every recorded decision (agreement 1, no disagreement).
import fc from 'fast-check';
import { afterEach, expect, test } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { KeyRecord } from '../../src/policy/types.js';
import { replay } from '../../src/replay/engine.js';
import { RULE_FIXTURES } from '../guardrails/fixtures.js';
import { authHeaders, send, startRawUpstream } from '../helpers/conformance.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const key = (plain: string, keyId: string, team: string | null): KeyRecord => ({ hash: hashKey(plain), keyId, tenant: 'acme', team, name: keyId, kind: 'developer', billing: 'api' });
const KEYS = { [TEST_KEY]: 'platform', ty_live_free: null, ty_live_web: 'web', ty_live_data: 'data' } as const;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

const req = fc.record({
  key: fc.constantFrom(...(Object.keys(KEYS) as Array<keyof typeof KEYS>)),
  model: fc.constantFrom('claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-9-9'),
  session: fc.option(fc.constantFrom('s0', 's1', 's2', 's3', 's4'), { freq: 3, nil: null }),
  text: fc.constantFrom('hello', 'hello', 'expensive', 'slow', 'leak', 'history'),
  path: fc.constantFrom('/v1/messages', '/v1/messages', '/v1/messages', '/v1/messages/count_tokens'),
  stream: fc.boolean(),
});
type Req = typeof req extends fc.Arbitrary<infer T> ? T : never;
/** Decision kinds the recorded mixes reached, across all runs. */
const reasons = new Set<string>();

function bodyOf(r: Req): string {
  const leak = `aws_access_key_id = ${AWS}`;
  const last = r.text === 'leak' ? leak : r.text === 'history' ? 'carry on' : r.text;
  const history = r.text === 'history' ? [{ role: 'user', content: leak }, { role: 'assistant', content: 'noted' }] : [];
  return JSON.stringify({ model: r.model, max_tokens: 64, ...(r.stream && r.path === '/v1/messages' ? { stream: true } : {}), messages: [...history, { role: 'user', content: last }] });
}

test('property: replaying the traces of any request mix under the recording policy reproduces every decision', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const up = await startRawUpstream((rq, res) => {
    const chunks: Buffer[] = [];
    rq.on('data', (c: Buffer) => chunks.push(c));
    rq.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; stream?: boolean; messages: Array<{ content: unknown }> };
      const text = JSON.stringify(body.messages.at(-1)?.content ?? '');
      const usage = text.includes('expensive') ? { input_tokens: 1000, output_tokens: 20_000 } : { input_tokens: 10, output_tokens: 1 };
      const wait = text.includes('slow') ? 60 : 0;
      setTimeout(() => {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const ev = (e: string, d: unknown): string => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
          res.end(ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } }) + ev('message_stop', { type: 'message_stop' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rq.url?.includes('count_tokens') ? { input_tokens: 10 } : { id: 'm', type: 'message', model: body.model, content: [], usage }));
        }
      }, wait);
    });
  });
  closers.push(up.close);

  let run = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(fc.array(req, { minLength: 1, maxLength: 6, size: 'max' }), { minLength: 1, maxLength: 5, size: 'max' }), async (waves) => {
      const policy = testPolicy({
        upstream: up.url,
        models: ['claude-haiku-*', 'claude-sonnet-5-5*'],
        extraKeys: [key('ty_live_free', 'key_free', null), key('ty_live_web', 'key_web', 'web'), key('ty_live_data', 'key_data', 'data')],
        edit: (p) => {
          p.budgets = p.budgets.map((b) => (b.name === 'team-day' ? { ...b, usd: 0.03 } : b));
          p.rateLimits = [
            { name: 'team-rpm', scope: 'team', rpm: 1, burst: 2 },
            { name: 'team-streams', scope: 'team', concurrentStreams: 1 },
          ];
          p.sessions = { ...p.sessions, newPerKeyPerHour: 2 };
          p.failure.unpricedModel = 'block';
        },
      });
      const traces: Rec[] = [];
      const gw = await startGateway({ policy, store: createMemoryStore({ clock: Date.now }), traces: { write: (r) => (traces.push(r), true) }, traceSalt: `salt${++run}`, runtime: createGatewayRuntime() });
      let sent = 0;
      try {
        for (const wave of waves) {
          await Promise.all(
            wave.map((r) => {
              sent++;
              return send(gw.url, { path: r.path, headers: { ...authHeaders, 'x-api-key': r.key, ...(r.session ? { 'x-claude-code-session-id': r.session } : {}) }, body: bodyOf(r) });
            }),
          );
        }
        await expect.poll(() => traces.length).toBe(sent);
      } finally {
        await gw.close();
      }
      async function* source(): AsyncIterable<LedgerLine> {
        yield* traces.map((t, i) => ({ ...t, instance: 'gw01', seq: i + 1 }));
      }
      const r = await replay({ base: policy, head: policy, traces: source(), sinceMs: null, tenant: null });
      expect(JSON.stringify(r.fidelity.disagreements)).toBe('[]');
      expect(r.fidelity.agreement).toBe(1);
      for (const t of traces) reasons.add(t.decision.reason ?? 'forward');
    }),
    fuzz(0xf1de, 20),
  );
  // The mixes reach every decision kind this policy can make.
  for (const k of ['forward', 'budget', 'model-not-allowed', 'rate', 'secret', 'streams', 'taint', 'unpriced']) expect(reasons, k).toContain(k);
}, fuzzTimeout(60_000));

