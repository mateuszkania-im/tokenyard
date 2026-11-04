import { expect, test } from 'vitest';
import { buildTraceRecord } from '../../src/edge/trace-record.js';
import type { RequestOutcome } from '../../src/edge/handler.js';
import type { PriceTable } from '../../src/pricing/prices.js';

/** Only lookupModel reads the table here: model `m` is priced. */
const PRICES = { version: 't', models: { m: {} }, modifiers: {}, serverTools: {} } as unknown as PriceTable;

const outcome = (o: Partial<RequestOutcome> = {}): RequestOutcome => ({
  id: 'r1',
  key: { hash: 'h', keyId: 'key_1', tenant: 't', team: null, name: 'n', kind: 'service', billing: 'subscription' },
  attribution: { session: 's', agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null },
  surface: 'anthropic-messages',
  features: { model: 'm', stream: true, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], bodyBytes: 7, prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: false, lastTurn: null },
  provider: 'anthropic',
  status: 200,
  usage: { usage: { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, source: 'final', midStreamError: null, sawStop: true, streamedChars: 8, responseModel: 'm' },
  aborted: false,
  startedAt: Date.UTC(2026, 10, 2),
  ttfbMs: 5,
  totalMs: 9,
  addedTtfbMs: 1,
  costMicroUsd: 3,
  costBasis: 'api-equivalent',
  client: { agent: 'codex', version: '0.9.1' },
  policyRevision: 'rev',
  route: { name: 'default', chain: ['anthropic'] },
  priceTable: 'v7',
  ...o,
});

test('builds the spec 9.1 record: key identity in clear, traffic from key kind, request start as ts', () => {
  const r = buildTraceRecord(outcome(), 'salt', { prices: PRICES, routes: [] });
  expect(r).toMatchObject({
    v: 1, kind: 'request', id: 'r1', ts: '2026-11-02T00:00:00.000Z', tenant: 't', team: null, keyId: 'key_1',
    traffic: 'product', billing: 'subscription', surface: 'anthropic-messages', client: { agent: 'codex', version: '0.9.1' },
    policy: { revision: 'rev' },
    decision: { route: 'default', action: 'forward', chain: ['anthropic'] },
    features: { model: 'm', stream: true, bodyBytes: 7, boundKind: 'bytes' },
    outcome: { provider: 'anthropic', status: 200, totalMs: 9, ttfbMs: 5, addedTtfbMs: 1, costMicroUsd: 3, costBasis: 'api-equivalent', usageSource: 'final', priceTable: 'v7', settledBy: 'request' },
  });
  expect(r.outcome.outputEstimated).toBeUndefined();
});

test("flags a final usage whose output was estimated from streamed chars", () => {
  const u = outcome().usage!;
  const r = buildTraceRecord(outcome({ usage: { ...u, outputEstimated: true } }), 'salt', { prices: PRICES, routes: [] });
  expect(r.outcome).toMatchObject({ usageSource: 'final', outputEstimated: true });
});

test('no usage is recorded as usageSource none with null usage and cost', () => {
  const r = buildTraceRecord(outcome({ usage: null, costMicroUsd: null }), 'salt', { prices: PRICES, routes: [] });
  expect(r.outcome).toMatchObject({ usage: null, usageSource: 'none', costMicroUsd: null });
});

test('records what replay needs to reproduce the reservation and the cost: fast mode, modifiers, server tool uses', () => {
  const u = outcome().usage!;
  const base = outcome();
  const r = buildTraceRecord(
    outcome({ features: { ...base.features, fastMode: true }, usage: { ...u, fast: true, serverToolUses: { web_search: 2 } }, costModifiers: ['inferenceGeoUs'] }),
    'salt',
    { prices: PRICES, routes: [] },
  );
  expect(r.features.fastMode).toBe(true);
  expect(r.outcome).toMatchObject({ fast: true, modifiers: ['inferenceGeoUs'], serverToolUses: { web_search: 2 } });
  const plain = buildTraceRecord(outcome({ costModifiers: [] }), 'salt', { prices: PRICES, routes: [] });
  expect(plain.features.fastMode).toBeUndefined();
  expect(plain.outcome.fast).toBeUndefined();
  expect(plain.outcome.modifiers).toBeUndefined();
  expect(plain.outcome.serverToolUses).toBeUndefined();
});

test('a request that ended before a decision is marked preDecision, so replay skips it', () => {
  expect(buildTraceRecord(outcome({ route: null, decision: { action: 'block', reason: 'body-too-large' } }), 'salt', { prices: PRICES, routes: [] }).decision.preDecision).toBe(true);
  expect(buildTraceRecord(outcome({ inputBound: { tokens: 10, kind: 'bytes' } }), 'salt', { prices: PRICES, routes: [] }).decision.preDecision).toBeUndefined();
});

test('records when admit was called, so replay admits in the order the store saw', () => {
  const r = buildTraceRecord(outcome({ inputBound: { tokens: 10, kind: 'bytes' }, admitAt: { offsetMs: 12, seq: 7 } }), 'salt', { prices: PRICES, routes: [] });
  expect(r.decision).toMatchObject({ admitOffsetMs: 12, admitSeq: 7 });
  const none = buildTraceRecord(outcome({ inputBound: { tokens: 10, kind: 'bytes' } }), 'salt', { prices: PRICES, routes: [] });
  expect(none.decision.admitOffsetMs).toBeUndefined();
  expect(none.decision.admitSeq).toBeUndefined();
});
