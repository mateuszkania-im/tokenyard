// Spec 9.2 step 5 end to end: traces written by the real gateway, replayed against the policy revision that recorded
// them, reproduce every recorded decision. Each decision kind the gateway can record is produced at least once.
import { afterEach, expect, test, vi } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { KeyRecord } from '../../src/policy/types.js';
import { replay } from '../../src/replay/engine.js';
import { RULE_FIXTURES } from '../guardrails/fixtures.js';
import { authHeaders, send, startRawUpstream } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const FREE = 'ty_live_free';
const WEB = 'ty_live_web';
const DATA = 'ty_live_data';
const BETA = 'ty_live_beta';
const key = (plain: string, keyId: string, team: string | null, tenant = 'acme'): KeyRecord => ({ hash: hashKey(plain), keyId, tenant, team, name: keyId, kind: 'developer', billing: 'api' });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
  vi.restoreAllMocks();
});

/** Answers with the requested model; the last user text picks the usage: expensive, huge (above the bytes bound), slow. */
async function upstream(onReceived: (text: string) => void) {
  const up = await startRawUpstream((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages: Array<{ content: unknown }> };
      const text = JSON.stringify(body.messages.at(-1)?.content ?? '');
      onReceived(text);
      const usage = text.includes('expensive') ? { input_tokens: 1000, output_tokens: 20_000 } : text.includes('huge') ? { input_tokens: 60_000, output_tokens: 1 } : { input_tokens: 10, output_tokens: 1 };
      const out = JSON.stringify({ id: 'msg_1', type: 'message', model: body.model, content: [], usage });
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(out), text.includes('slow') ? 300 : 0);
    });
  });
  closers.push(up.close);
  return up;
}

test('replaying traces against their own revision reproduces every recorded decision (fidelity 100%)', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const received: string[] = [];
  const up = await upstream((t) => received.push(t));
  const policy = testPolicy({
    upstream: up.url,
    models: ['claude-haiku-*', 'claude-sonnet-5-5*'],
    extraKeys: [key(FREE, 'key_free', null), key(WEB, 'key_web', 'web'), key(DATA, 'key_data', 'data'), key(BETA, 'key_beta', null, 'beta')],
    editRoutes: (routes) => {
      // Tenant beta has no route at all.
      for (const r of routes) if (r.name === 'claude-code') r.match.tenant = 'acme';
      routes.unshift({
        name: 'compaction',
        match: { surface: 'anthropic-messages', traffic: 'coding-agent', requestClass: 'compaction' },
        chain: ['anthropic'],
        rewriteModel: 'claude-haiku-5-5',
        allowBodyRewrite: true,
        because: 'test',
      });
    },
    edit: (p) => {
      p.tenants.beta = { teams: [] };
      // Team levels only: the team-less key FREE is under none of them.
      p.budgets = p.budgets.map((b) => (b.name === 'team-day' ? { ...b, usd: 0.012 } : b));
      p.rateLimits = [
        { name: 'team-rpm', scope: 'team', rpm: 1, burst: 2 },
        { name: 'team-streams', scope: 'team', concurrentStreams: 1 },
      ];
      p.failure.unpricedModel = 'block';
    },
  });
  const inner = createMemoryStore({ clock: Date.now });
  let down = false;
  const store: CounterStore = { ...inner, admit: (plan, now) => (down ? new Promise(() => undefined) : inner.admit(plan, now)) };
  const traces: Rec[] = [];
  const gw = await startGateway({ policy, store, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 'salt', runtime: createGatewayRuntime(), admitTimeoutMs: 100 });
  closers.push(gw.close);

  const msg = (text: string, o: { model?: string; tools?: unknown[]; history?: unknown[] } = {}): string =>
    JSON.stringify({ model: o.model ?? 'claude-haiku-5-5', max_tokens: 64, ...(o.tools ? { tools: o.tools } : {}), messages: [...(o.history ?? []), { role: 'user', content: text }] });
  const post = (plain: string, body: string, h: Record<string, string> = {}, path = '/v1/messages') =>
    send(gw.url, { path, headers: { ...authHeaders, 'x-api-key': plain, 'x-claude-code-session-id': 's1', ...h }, body });
  const statuses: number[] = [];
  const go = async (p: ReturnType<typeof post>): Promise<void> => void statuses.push((await p).status);

  await go(post(FREE, msg('hello')));
  await go(post(FREE, msg('again')));
  // Rate: team platform may send 2 at once, the 3rd within a minute is refused.
  for (const t of ['p1', 'p2', 'p3']) await go(post(authHeaders['x-api-key'], msg(t), { 'x-claude-code-session-id': 'sp' }));
  // Streams: team web holds its one slot while a second request arrives.
  const slow = post(WEB, msg('slow'), { 'x-claude-code-session-id': 'sw' });
  await expect.poll(() => received.some((t) => t.includes('slow'))).toBe(true);
  await go(post(WEB, msg('second'), { 'x-claude-code-session-id': 'sw' }));
  await go(slow);
  // Model allowlist, the header-selected compaction route with its rewrite, and the authz route that still applies.
  await go(post(FREE, msg('opus please', { model: 'claude-opus-5-5' })));
  await go(post(FREE, msg('compact', { model: 'claude-sonnet-5-5' }), { 'x-claude-code-request-class': 'compaction' }));
  await go(post(FREE, msg('compact opus', { model: 'claude-opus-5-5' }), { 'x-claude-code-request-class': 'compaction' }));
  await go(post(FREE, msg('count'), {}, '/v1/messages/count_tokens'));
  await go(post(BETA, msg('no route for this tenant')));
  await go(post(FREE, msg('fetch', { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1 }] })));
  await go(post(FREE, msg('unpriced', { model: 'claude-haiku-9-9' })));
  // Secret in the last turn, then the same secret in the history of the next turn: taint.
  const leak = `aws_access_key_id = ${AWS}`;
  await go(post(FREE, msg(leak), { 'x-claude-code-session-id': 'sec' }));
  await go(post(FREE, msg('carry on', { history: [{ role: 'user', content: leak }, { role: 'assistant', content: 'noted' }] }), { 'x-claude-code-session-id': 'sec' }));
  // Budget: team data spends 10,100 micro-USD, then a second reservation does not fit 12,000.
  await go(post(DATA, msg('expensive'), { 'x-claude-code-session-id': 'sd' }));
  await go(post(DATA, msg('next'), { 'x-claude-code-session-id': 'sd' }));
  // Store down: the admit never answers; budgets fail closed.
  down = true;
  await go(post(FREE, msg('store down')));
  down = false;
  // R11: billed input above the bytes bound; every later request reserves the context window, so team data's next
  // reservation is larger than its whole budget.
  await go(post(FREE, msg('huge')));
  await go(post(FREE, msg('after the latch')));
  await go(post(DATA, msg('oversized'), { 'x-claude-code-session-id': 'sd2' }));

  await expect.poll(() => traces.length).toBe(statuses.length);
  expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('the bytes bound is off')]);
  const lines: LedgerLine[] = traces.map((t, i) => ({ ...t, instance: 'gw01', seq: i + 1 }));
  const reasons = [...new Set(traces.map((t) => t.decision.reason ?? 'forward'))].sort();
  expect(reasons).toEqual(['budget', 'forward', 'model-not-allowed', 'no-route', 'rate', 'secret', 'server-tool-not-allowed', 'store-down', 'streams', 'taint', 'unpriced']);
  expect(traces.some((t) => t.decision.route === 'compaction' && t.outcome.upstreamModel === 'claude-haiku-5-5')).toBe(true);
  expect(traces.filter((t) => t.features.boundKind === 'context-window' && t.features.serverTools.length === 0).length).toBeGreaterThanOrEqual(2);
  expect(traces.filter((t) => t.decision.reason === 'budget')).toHaveLength(2);

  async function* source(): AsyncIterable<LedgerLine> {
    yield* lines;
  }
  const r = await replay({ base: policy, head: policy, traces: source(), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toEqual([]);
  expect(r.fidelity.agreement).toBe(1);
  expect(r.requests).toBe(traces.length);
  expect(r.head).toEqual(r.base);
  expect(r.base.costMicroUsd).toBe(traces.reduce((s, t) => s + (t.decision.action === 'forward' ? (t.outcome.costMicroUsd ?? 0) : 0), 0));
  expect(r.cutSessions).toEqual([]);
  expect(r.rerouted).toEqual([]);
});
