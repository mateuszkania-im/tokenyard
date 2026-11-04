// S-V4-4 (V4 fix review, Medium, privacy): `traces export --anonymize` copied `decision.seqEpoch`, the gateway's random
// process id, verbatim. Like the instance id and the session HMACs it is a linkable id: the same value in two exports,
// and in the raw traces, ties them together. Exports now re-key it with the export salt (kind `epoch`), as every other
// linkable id; equality within one export survives, so replay orders settles exactly as from the raw traces.
import { afterEach, expect, test } from 'vitest';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { replay } from '../../src/replay/engine.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';
import { closers, record, type Rec } from '../helpers/settle-order.js';

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

const full = (traces: Rec[]): TraceRecord[] => traces.map((t, i) => ({ ...t, instance: 'gw01', seq: i + 1 }));
const source = (xs: TraceRecord[]): AsyncIterable<LedgerLine> =>
  (async function* () {
    yield* xs;
  })();

/** Recorded traces plus the same holder an hour later as the first admit of a restarted process (another epoch). */
async function withRestart(): Promise<{ policy: Awaited<ReturnType<typeof record>>['policy']; raw: TraceRecord[] }> {
  const { policy, traces } = await record();
  const holder = traces.find((t) => t.decision.action === 'forward') as Rec;
  const later: Rec = structuredClone(holder);
  later.id = 'req_after_restart';
  later.ts = new Date(Date.parse(holder.ts) + 3_600_000).toISOString();
  later.decision.admitSeq = 1;
  later.decision.seqEpoch = 'feedfacefeedface';
  later.outcome.settleSeq = 1;
  return { policy, raw: full([...traces, later]) };
}

const exported = (raw: TraceRecord[], salt: string): TraceRecord[] => raw.map((r) => anonymizeRecord(r, saltedPseudonyms(salt)));

test('S-V4-4 an export holds no raw process epoch, and two exports with different salts share no epoch value', async () => {
  const { raw } = await withRestart();
  const a = exported(raw, 'salt-a');
  const b = exported(raw, 'salt-b');
  const rawEpochs = new Set(raw.map((r) => r.decision.seqEpoch));
  expect(rawEpochs.size).toBe(2);
  for (const e of rawEpochs) {
    expect(JSON.stringify(a)).not.toContain(e as string);
    expect(JSON.stringify(b)).not.toContain(e as string);
  }
  const ea = new Set(a.map((r) => r.decision.seqEpoch));
  const eb = new Set(b.map((r) => r.decision.seqEpoch));
  expect(ea.size).toBe(2); // one value per process, as in the raw traces
  for (const e of ea) expect(eb.has(e)).toBe(false);
});

test('S-V4-4 replay from an export gives the decisions replay from the raw traces gives, restart included', async () => {
  const { policy, raw } = await withRestart();
  const fromRaw = await replay({ base: policy, head: policy, traces: source(raw), sinceMs: null, tenant: null });
  // Only the process epoch and the instance id are re-keyed here: the policy names the tenant and key in clear.
  const p = saltedPseudonyms('salt-a');
  const keyed = raw.map((r) => {
    const x = anonymizeRecord(r, p);
    return { ...r, instance: x.instance, decision: { ...r.decision, ...(x.decision.seqEpoch !== undefined ? { seqEpoch: x.decision.seqEpoch } : {}) } } as TraceRecord;
  });
  const fromExport = await replay({ base: policy, head: policy, traces: source(keyed), sinceMs: null, tenant: null });
  expect(fromRaw.fidelity.disagreements).toEqual([]);
  expect(fromExport.fidelity).toEqual(fromRaw.fidelity);
  expect(fromExport.blocked).toEqual(fromRaw.blocked);
  expect(fromExport.base).toEqual(fromRaw.base);
});
