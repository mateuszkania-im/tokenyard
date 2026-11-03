// V4 replay fidelity finding: the gateway measures totalMs before it settles, and replay settled every record at
// ts + totalMs, before any admit in the same millisecond. A request that finished and released its stream slot (or
// its reservation) just after a racing admit of the same instance was replayed as released before it, so a recorded
// `streams` or `budget` refusal replayed as forwarded. The gateway now records `outcome.settleSeq`, the number of
// admits it had issued when it called settle; replay applies a settle before an admit of the same instance exactly
// when settleSeq is below that admit's admitSeq. Records without it keep the time rule.
// V4 review (I1): the admit count starts again at 0 when a process restarts, and `--instance-id` may be reused across
// restarts (a pod name), so a settleSeq from before the restart was compared with admitSeqs of the new process and an
// old release was held until the new process had issued as many admits. Every record now carries `decision.seqEpoch`,
// a random id of the writing process; seqs are compared only within one (instance, epoch), otherwise the time rule.
import { afterEach, expect, test } from 'vitest';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { replay } from '../../src/replay/engine.js';
import { authHeaders, send, startRawUpstream } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

async function record(): Promise<{ policy: ReturnType<typeof testPolicy>; traces: Rec[] }> {
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

const lines = (traces: Rec[]): AsyncIterable<LedgerLine> =>
  (async function* () {
    yield* traces.map((t, i) => ({ ...t, instance: 'gw01', seq: i + 1 }));
  })();

test('the gateway records settleSeq: the admits it had issued when it settled', async () => {
  const { traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  const refused = traces.find((t) => t.decision.reason === 'streams') as Rec;
  expect(holder.decision.admitSeq).toBe(1);
  expect(refused.decision.admitSeq).toBe(2);
  expect(holder.outcome.settleSeq).toBe(2);
});

test('a release recorded in the same millisecond as a later admit of the instance is replayed after it (fidelity 100%)', async () => {
  const { policy, traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  const refused = traces.find((t) => t.decision.reason === 'streams') as Rec;
  // The tie: the holder's recorded end is the very millisecond the refused request called admit.
  const admitAt = Date.parse(refused.ts) + (refused.decision.admitOffsetMs ?? 0);
  holder.outcome.totalMs = admitAt - Date.parse(holder.ts);
  const r = await replay({ base: policy, head: policy, traces: lines(traces), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toEqual([]);
  expect(r.fidelity.agreement).toBe(1);
});

test('every record carries the process epoch: one value per runtime, another after a restart', async () => {
  const a = await record();
  const b = await record();
  const epochs = (t: Rec[]): Set<unknown> => new Set(t.map((x) => x.decision.seqEpoch));
  expect(epochs(a.traces).size).toBe(1);
  expect([...epochs(a.traces)][0]).toMatch(/^[0-9a-f]{16}$/);
  expect([...epochs(b.traces)][0]).not.toBe([...epochs(a.traces)][0]);
});

test('I1 a restarted process reusing the instance id: its admit counts are not compared with the old process settleSeq', async () => {
  const { policy, traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  // The reviewer's reproduction: the same request again an hour later on the same instance id, as the first admit of a
  // new process (admitSeq 1, settleSeq 1). The old holder settled with settleSeq 2, which is not below 1.
  const later: Rec = structuredClone(holder);
  later.id = 'req_after_restart';
  later.ts = new Date(Date.parse(holder.ts) + 3_600_000).toISOString();
  later.decision.admitSeq = 1;
  later.decision.seqEpoch = 'feedfacefeedface';
  later.outcome.settleSeq = 1;
  const r = await replay({ base: policy, head: policy, traces: lines([...traces, later]), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toEqual([]);
  expect(r.fidelity.agreement).toBe(1);
});

test('records with settleSeq but no epoch (written before it) keep the time rule', async () => {
  const { policy, traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  const refused = traces.find((t) => t.decision.reason === 'streams') as Rec;
  for (const t of traces) delete t.decision.seqEpoch;
  // Ended a millisecond before the refused admit: with no epoch the time rule releases first, whatever settleSeq says.
  holder.outcome.totalMs = Date.parse(refused.ts) + (refused.decision.admitOffsetMs ?? 0) - 1 - Date.parse(holder.ts);
  const r = await replay({ base: policy, head: policy, traces: lines(traces), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toHaveLength(1);
});

test('records without settleSeq (written before it) keep the time rule', async () => {
  const { policy, traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  const refused = traces.find((t) => t.decision.reason === 'streams') as Rec;
  delete holder.outcome.settleSeq;
  // Ended a millisecond before the refused admit: the time rule releases first, as it always did.
  holder.outcome.totalMs = Date.parse(refused.ts) + (refused.decision.admitOffsetMs ?? 0) - 1 - Date.parse(holder.ts);
  const r = await replay({ base: policy, head: policy, traces: lines(traces), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toHaveLength(1);
});

test('a record that calls no admit, sorted between the release and the racing admit, does not release it early', async () => {
  const { policy, traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  const refused = traces.find((t) => t.decision.reason === 'streams') as Rec;
  const admitAt = Date.parse(refused.ts) + (refused.decision.admitOffsetMs ?? 0);
  holder.outcome.totalMs = admitAt - Date.parse(holder.ts);
  // A record of the same instance without an admit (a request with nothing to reserve) at that very millisecond: it
  // sorts before the refused admit (no admitSeq), and its drain must not free the slot the refused admit found held.
  const quiet: Rec = { ...structuredClone(refused), id: 'req_quiet', ts: new Date(admitAt).toISOString(), decision: { ...structuredClone(refused.decision), action: 'forward', reason: null, admitOffsetMs: undefined, admitSeq: undefined, preDecision: true } };
  delete quiet.decision.admitOffsetMs;
  delete quiet.decision.admitSeq;
  const r = await replay({ base: policy, head: policy, traces: lines([holder, quiet, refused]), sinceMs: null, tenant: null });
  expect(r.fidelity.disagreements).toEqual([]);
});

test('anonymized exports keep the process epoch the gateway writes and drop any other value', async () => {
  const { traces } = await record();
  const p = saltedPseudonyms('export');
  const rec = { ...(traces[0] as Rec), instance: 'gw01', seq: 1 };
  expect(anonymizeRecord(rec, p).decision.seqEpoch).toBe(rec.decision.seqEpoch);
  expect(anonymizeRecord({ ...rec, decision: { ...rec.decision, seqEpoch: 'jane@example.com' } }, p).decision.seqEpoch).toBeUndefined();
});
