import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { expect, test } from 'vitest';
import { buildTraceRecord } from '../../src/edge/trace-record.js';
import type { RequestOutcome } from '../../src/edge/handler.js';
import type { PriceTable } from '../../src/pricing/prices.js';

const PRICES = { version: 't', models: { 'claude-sonnet-5-5': {} }, modifiers: {}, serverTools: {} } as unknown as PriceTable;
import { createTracer, inputTokens } from '../../src/telemetry/otel.js';
import { GEN_AI, TOKENYARD } from '../../src/telemetry/semconv.js';

const outcome = (o: Partial<RequestOutcome> = {}): RequestOutcome => ({
  id: 'r1',
  key: { hash: 'h', keyId: 'key_1', tenant: 'acme', team: 'platform', name: 'n', kind: 'developer', billing: 'api' },
  attribution: { session: 'raw-session-id', agent: 'raw-agent', parentAgent: null, requestClass: 'main', agentType: null, promptId: 'raw-prompt', repo: '/home/dev/secret-repo', branch: 'main', ticket: null, feature: null },
  surface: 'anthropic-messages',
  features: { model: 'claude-sonnet-5-5', stream: true, maxOutputTokens: 64, toolCount: 0, thinking: false, serverTools: [], bodyBytes: 7, prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: false, lastTurn: null },
  provider: 'anthropic-backup',
  status: 200,
  usage: { usage: { input: 10, output: 20, cacheRead: 300, cacheWrite5m: 4, cacheWrite1h: 5 }, source: 'final', midStreamError: null, sawStop: true, streamedChars: 8, responseModel: 'claude-sonnet-5-5-20260101' },
  aborted: false,
  startedAt: Date.UTC(2026, 10, 2),
  ttfbMs: 50,
  totalMs: 900,
  addedTtfbMs: 2,
  costMicroUsd: 1234,
  costBasis: 'billed',
  client: { agent: 'claude-code', version: '2.0.0' },
  policyRevision: 'rev1',
  attempts: 2,
  route: { name: 'claude-code', chain: ['anthropic', 'anthropic-backup'] },
  priceTable: 'v7',
  ...o,
});

test('gen_ai.usage.input_tokens = input + cache read + cache write', () => {
  expect(inputTokens({ input: 10, output: 20, cacheRead: 300, cacheWrite5m: 4, cacheWrite1h: 5 })).toBe(319);
});

test('one SERVER span per request and one CLIENT span per upstream attempt named "<operation> <model>"', async () => {
  const exporter = new InMemorySpanExporter();
  const sink = await createTracer(null, { exporter });
  const rec = buildTraceRecord(outcome(), 'salt', { prices: PRICES, routes: [] });
  const t0 = Date.UTC(2026, 10, 2);
  sink.requestSpan(
    rec,
    [
      { provider: 'anthropic', startMs: t0 + 1, endMs: t0 + 20, status: 529 },
      { provider: 'anthropic-backup', startMs: t0 + 21, endMs: t0 + 50, status: 200 },
    ],
    'claude-sonnet-5-5',
  );
  const spans = exporter.getFinishedSpans(); // shutdown() clears the in-memory exporter
  await sink.shutdown();
  const server = spans.filter((s) => s.kind === 1);
  const clients = spans.filter((s) => s.kind === 2);
  expect(server).toHaveLength(1);
  expect(clients).toHaveLength(2);
  for (const c of clients) {
    expect(c.name).toBe('chat claude-sonnet-5-5');
    expect(c.parentSpanContext?.spanId).toBe(server[0]?.spanContext().spanId);
  }
  const [failed, answered] = clients;
  expect(failed?.attributes[GEN_AI.errorType]).toBe('529');
  expect(failed?.status.code).toBe(2);
  expect(failed?.attributes[GEN_AI.usageInputTokens]).toBeUndefined();
  expect(answered?.attributes).toMatchObject({
    [GEN_AI.operationName]: 'chat',
    [GEN_AI.providerName]: 'anthropic',
    [GEN_AI.requestModel]: 'claude-sonnet-5-5',
    [GEN_AI.responseModel]: 'claude-sonnet-5-5-20260101',
    [GEN_AI.requestStream]: true,
    [GEN_AI.usageInputTokens]: 319,
    [GEN_AI.usageOutputTokens]: 20,
    [GEN_AI.usageCacheReadInputTokens]: 300,
    [GEN_AI.usageCacheWriteInputTokens]: 9,
    [GEN_AI.responseTimeToFirstChunk]: 0.05,
    [TOKENYARD.provider]: 'anthropic-backup',
  });
  expect(server[0]?.attributes).toMatchObject({
    [TOKENYARD.tenant]: 'acme',
    [TOKENYARD.route]: 'claude-code',
    [TOKENYARD.decision]: 'forward',
    [TOKENYARD.costUsd]: 0.001234,
    [TOKENYARD.policyRevision]: 'rev1',
    [TOKENYARD.addedTtfbMs]: 2,
  });
});

test('spans hold pseudonyms, never raw ids, repo paths, branch names or prompt text', async () => {
  const exporter = new InMemorySpanExporter();
  const sink = await createTracer(null, { exporter });
  sink.requestSpan(buildTraceRecord(outcome(), 'salt', { prices: PRICES, routes: [] }));
  const finished = exporter.getFinishedSpans();
  await sink.shutdown();
  const dump = JSON.stringify(finished.map((s) => ({ n: s.name, a: s.attributes, e: s.events })));
  expect(dump).not.toMatch(/raw-session-id|raw-agent|raw-prompt|secret-repo|ty_live|sk-/);
  const server = finished.find((s) => s.kind === 1);
  expect(server?.attributes[GEN_AI.conversationId]).toMatch(/^[0-9a-f]{32}$/);
  expect(server?.attributes[TOKENYARD.agentId]).toMatch(/^[0-9a-f]{32}$/);
  expect(Object.keys(server?.attributes ?? {}).some((k) => k.startsWith('gen_ai.input') || k.startsWith('gen_ai.output'))).toBe(false);
});

test('a request that never reached a provider gets a SERVER span only', async () => {
  const exporter = new InMemorySpanExporter();
  const sink = await createTracer(null, { exporter });
  sink.requestSpan(buildTraceRecord(outcome({ provider: null, usage: null, status: 429, decision: { action: 'block', reason: 'budget' }, errorClass: 'rate_limit_error' }), 'salt', { prices: PRICES, routes: [] }));
  const spans = exporter.getFinishedSpans(); // shutdown() clears the in-memory exporter
  await sink.shutdown();
  expect(spans.map((s) => s.kind)).toEqual([1]);
  expect(spans[0]?.attributes[TOKENYARD.decision]).toBe('block');
});

test('span names use the priced model or "other"; an unpriced request model is a salted pseudonym in the attribute (B1)', async () => {
  const exporter = new InMemorySpanExporter();
  const sink = await createTracer(null, { exporter });
  const rec = buildTraceRecord(outcome({ features: { ...outcome().features, model: 'evil\nmodel-' + 'x'.repeat(300) } }), 'salt', { prices: PRICES, routes: [] });
  sink.requestSpan(rec, undefined, 'other');
  sink.requestSpan(buildTraceRecord(outcome(), 'salt', { prices: PRICES, routes: [] }));
  const clients = exporter.getFinishedSpans().filter((s) => s.kind === 2);
  expect(clients.map((c) => c.name)).toEqual(['chat other', 'chat other']);
  const attr = String(clients[0]?.attributes[GEN_AI.requestModel]);
  expect(attr).toMatch(/^model-[0-9a-f]{16}$/);
  await sink.shutdown();
});
