// Second-pass observation (security review A): the body-shape refusals (a BOM, duplicate keys, nesting too deep, and
// JSON that does not parse under an enforced budget) depend on body bytes the trace does not hold, but were missing
// from the replay engine's BODY_EXITS. A record of one that carries no `preDecision` marker was decided again from its
// features and replayed as forwarded: a fidelity disagreement. They are now carried over as recorded, before decide
// (the gateway refuses them before deciding, so the recorded route and chain are empty).
import { afterEach, expect, test } from 'vitest';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { replay } from '../../src/replay/engine.js';
import { send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { TEST_KEY, testPolicy } from '../helpers/policy.js';
import { closeAll, closers, raw, readJson } from './common.js';

afterEach(closeAll);

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const auth = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };

test('body-shape refusals replay with fidelity 100%, with or without the preDecision marker', async () => {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
  });
  const traces: Rec[] = [];
  const policy = testPolicy({ upstream: up.url });
  const g = await startGateway({ policy, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 'salt' });
  closers.push(g.close);
  const ok = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
  const bodies = [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ok)]),
    Buffer.from('{"model":"claude-haiku-5-5","model":"claude-opus-5-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'),
    Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}],"metadata":${'['.repeat(200)}${']'.repeat(200)}}`),
    Buffer.from('{"model":"claude-haiku-5-5","max_tokens":16,'),
    Buffer.from(ok),
  ];
  for (const [i, body] of bodies.entries()) {
    await send(g.url, { path: '/v1/messages', headers: auth, body });
    await expect.poll(() => traces.length).toBe(i + 1);
  }
  expect(traces.map((t) => t.decision.reason ?? 'forward')).toEqual(['body-bom', 'duplicate-keys', 'too-deep', 'unparsable-body', 'forward']);

  const run = async (recs: Rec[]) => {
    const lines: LedgerLine[] = recs.map((t, i) => ({ ...t, instance: 'gw', seq: i + 1 }));
    async function* source(): AsyncIterable<LedgerLine> {
      yield* lines;
    }
    return replay({ base: policy, head: policy, traces: source(), sinceMs: null, tenant: null });
  };
  const recorded = await run(traces);
  expect(recorded.fidelity.disagreements).toEqual([]);
  // A record without the marker (an exit whose outcome carried a bound) is still carried over as recorded.
  const unmarked = traces.map((t) => {
    const { preDecision: _drop, ...decision } = t.decision;
    return { ...t, decision };
  });
  const r = await run(unmarked);
  expect(r.fidelity.disagreements).toEqual([]);
  expect(r.fidelity.agreement).toBe(1);
  expect(r.head.forwarded).toBe(1);
});
