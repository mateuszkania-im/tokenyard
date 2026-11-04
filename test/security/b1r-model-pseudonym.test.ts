// B1 fix round (controller ruling): a model name stays in clear in traces, spans and exports only when the price table
// prices it or it equals a wildcard-free allowModels entry (validation already requires those to be priced). Any other name (one an example-policy glob such as
// claude-haiku-* accepts included) is written as a salted pseudonym model-<hex>: the trace salt in traces and spans,
// re-keyed with the export salt in anonymized exports. Replay keeps 100% fidelity through `features.modelGlobs`, the
// policy's own model patterns the clear name matched (operator text, never client text).
import { afterEach, expect, test } from 'vitest';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { replay } from '../../src/replay/engine.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { clientAttributes, serverAttributes, type SpanSink } from '../../src/telemetry/otel.js';
import { send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { TEST_KEY, testPolicy } from '../helpers/policy.js';
import { closeAll, closers, raw, readJson } from './common.js';

afterEach(closeAll);

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const auth = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
/** The example policy's claude-code globs. */
const GLOBS = ['claude-opus-5-5*', 'claude-sonnet-5-5*', 'claude-haiku-*'];
const CANARY_MODEL = 'claude-haiku-canary0123456789abcdef0123456789abcdef';

async function setup(models: string[]) {
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
  });
  const traces: Rec[] = [];
  const spans: string[] = [];
  const sink: SpanSink = { requestSpan: (r) => void spans.push(JSON.stringify([serverAttributes(r), clientAttributes(r, null, true)])), shutdown: () => Promise.resolve() };
  const policy = testPolicy({ upstream: up.url, models });
  const g = await startGateway({ policy, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 'trace-salt', metrics: createMetrics(), spans: sink });
  closers.push(g.close);
  const post = async (model: string): Promise<Rec> => {
    const n = traces.length;
    await send(g.url, { path: '/v1/messages', headers: auth, body: Buffer.from(JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
    await expect.poll(() => traces.length).toBe(n + 1);
    return traces.at(-1) as Rec;
  };
  return { policy, traces, spans, post };
}

test('B1r a name an example-policy glob accepts is a trace-salted pseudonym in traces, spans and exports', async () => {
  const s = await setup(GLOBS);
  const rec = await s.post(CANARY_MODEL);
  expect(rec.features.model).toMatch(/^model-[0-9a-f]{16}$/);
  expect(JSON.stringify(rec)).not.toContain('canary');
  await expect.poll(() => s.spans.length).toBeGreaterThan(0);
  expect(s.spans.join('\n')).not.toContain('canary');
  // The same name maps to the same pseudonym within the trace salt.
  expect((await s.post(CANARY_MODEL)).features.model).toBe(rec.features.model);
  // Anonymized: re-keyed with the export salt, so it matches nothing in the raw traces.
  const a = anonymizeRecord({ ...rec, instance: 'i', seq: 1 } as TraceRecord, saltedPseudonyms('export-salt'));
  expect(a.features.model).toMatch(/^model-[0-9a-f]{8}$/);
  expect(a.features.model).not.toBe(rec.features.model);
  expect(JSON.stringify(a)).not.toContain('canary');
});

test('B1r priced names, a wildcard-free allowModels entry included, stay in clear', async () => {
  const s = await setup([...GLOBS, 'claude-sonnet-5-5']);
  expect((await s.post('claude-haiku-5-5')).features.model).toBe('claude-haiku-5-5');
  expect((await s.post('claude-sonnet-5-5')).features.model).toBe('claude-sonnet-5-5');
  expect((await s.post('claude-haiku-5-5')).features.modelGlobs).toBeUndefined();
});

test('B1r replay of pseudonymised models reproduces every recorded decision', async () => {
  const s = await setup(['claude-haiku-*']);
  await s.post('claude-haiku-9-9'); // allowed by the glob, refused as unpriced
  await s.post('claude-zzz-1'); // not allowed
  await s.post('claude-haiku-5-5');
  expect(s.traces.map((t) => t.decision.reason ?? 'forward')).toEqual(['unpriced', 'model-not-allowed', 'forward']);
  expect(s.traces[0]?.features.model).toMatch(/^model-/);
  const lines: LedgerLine[] = s.traces.map((t, i) => ({ ...t, instance: 'gw', seq: i + 1 }));
  async function* source(): AsyncIterable<LedgerLine> {
    yield* lines;
  }
  const r = await replay({ base: s.policy, head: s.policy, traces: source(), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toEqual([]);
  expect(r.fidelity.agreement).toBe(1);
});
