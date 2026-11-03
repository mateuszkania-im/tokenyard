// V4 property: reservations and stream slots are released on every outcome. Each request of a batch gets its own
// upstream behaviour (answer, streamed answer, stream cut mid-way, 5xx or 529 with fallback, connection reset, a hang
// past the deadline) and its own client behaviour (stays, leaves before the body, mid-upload, after the headers, after
// some bytes or after some milliseconds); all run at once through a real gateway on the memory store. Afterwards
// the V3 invariants hold (test/chaos/harness.ts): one trace line per request received, every reservation settled by
// the request at no less than what the provider billed, no open reservation, deadline or stream slot, nothing reserved.
import fc from 'fast-check';
import { afterEach, test } from 'vitest';
import { type Behaviour, chaosRequest, chatBody, checkInvariants, type ClientMode, type Harness, startHarness } from '../chaos/harness.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const behaviour: fc.Arbitrary<{ primary: Behaviour; backup: Behaviour }> = fc.oneof(
  fc.record({ stream: fc.boolean(), ttfbMs: fc.integer({ min: 0, max: 30 }), padEvents: fc.integer({ min: 0, max: 30 }) }).map((o) => ({ primary: { kind: 'ok' as const, chunkDelayMs: 1, ...o }, backup: { kind: 'ok' as const } })),
  fc.integer({ min: 50, max: 2_000 }).map((cutAt) => ({ primary: { kind: 'ok' as const, stream: true, cutAt, padEvents: 30 }, backup: { kind: 'ok' as const } })),
  fc.tuple(fc.constantFrom(500, 502, 503, 529, 429), fc.boolean()).map(([status, backupFails]) => ({ primary: { kind: 'status' as const, status }, backup: backupFails ? { kind: 'status' as const, status: 503 } : { kind: 'ok' as const, stream: true } })),
  fc.constant({ primary: { kind: 'reset' as const }, backup: { kind: 'ok' as const } }),
  fc.constant({ primary: { kind: 'ok' as const, stream: true, cutAfterHeaders: true }, backup: { kind: 'ok' as const } }),
);
const client: fc.Arbitrary<ClientMode> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'normal' as const }) },
  fc.constantFrom<ClientMode>({ kind: 'abortBeforeBody' }, { kind: 'abortMidUpload' }, { kind: 'abortAfterHeaders' }),
  fc.integer({ min: 1, max: 600 }).map((bytes) => ({ kind: 'abortAfterBytes' as const, bytes })),
  fc.integer({ min: 0, max: 60 }).map((ms) => ({ kind: 'abortAfterMs' as const, ms })),
);
const request = fc.record({ behaviour, client, stream: fc.boolean(), padBytes: fc.integer({ min: 0, max: 30_000 }) });

let batch = 0;
test('property: every admitted request settles exactly once and nothing stays held, for any mix of upstream and client failures', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(request, { minLength: 1, maxLength: 12 }), async (reqs) => {
      h = await startHarness();
      const b = ++batch;
      const byId = new Map(reqs.map((r, i) => [`rel${b}x${i}`, r.behaviour]));
      h.setBehaviour(({ chaosId, provider }) => {
        const x = byId.get(chaosId);
        return x ? (provider === 'anthropic' ? x.primary : x.backup) : { kind: 'ok' };
      });
      const sent = await Promise.all(reqs.map((r, i) => chaosRequest((h as Harness).url, `rel${b}x${i}`, chatBody(`rel${b}x${i}`, { stream: r.stream, padBytes: r.padBytes }), r.client)));
      await checkInvariants(h, sent);
      await h.close();
      h = null;
    }),
    fuzz(0x4e1e, 12, { endOnFailure: true }),
  );
}, fuzzTimeout(60_000));
