import { expect, test } from 'vitest';
import { buildTraceRecord } from '../../src/edge/trace-record.js';
import type { RequestOutcome } from '../../src/edge/handler.js';

const outcome = (o: Partial<RequestOutcome> = {}): RequestOutcome => ({
  id: 'r1',
  key: { hash: 'h', keyId: 'key_1', tenant: 't', team: null, name: 'n', kind: 'service', billing: 'subscription' },
  attribution: { session: 's', agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null },
  surface: 'anthropic-messages',
  features: { model: 'm', stream: true, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], bodyBytes: 7, prefixHash: null, blockTypes: [], expandsServerSide: false, parseError: false, lastTurn: null },
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
  const r = buildTraceRecord(outcome(), 'salt');
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
  const r = buildTraceRecord(outcome({ usage: { ...u, outputEstimated: true } }), 'salt');
  expect(r.outcome).toMatchObject({ usageSource: 'final', outputEstimated: true });
});

test('no usage is recorded as usageSource none with null usage and cost', () => {
  const r = buildTraceRecord(outcome({ usage: null, costMicroUsd: null }), 'salt');
  expect(r.outcome).toMatchObject({ usage: null, usageSource: 'none', costMicroUsd: null });
});
