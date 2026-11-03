// S-V4-3 (V4 review, Low, privacy): server tool types are client-chosen. The ingest bound (`[a-z0-9_]{1,64}`, B1)
// kept any such value in raw traces, and S-V4-2 kept every lowercase word shape in exports (`jane_doe`,
// `project_falcon_lookup`). A raw trace now keeps a type in clear only when it is a known server tool type (the
// providers' documented types, any date suffix) or one the recording policy names (a price table entry or a route's
// `serverTools`); any other type becomes the bounded placeholder `tool_<16 hex>` (HMAC with the trace salt, so equal
// types stay equal). Exports keep only the known types and pseudonymise the rest, whatever their shape.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { buildTraceRecord } from '../../src/edge/trace-record.js';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import type { PriceTable } from '../../src/pricing/prices.js';
import type { CompiledRoute } from '../../src/policy/types.js';
import { fuzz } from '../helpers/fuzz.js';
import { baseRecord } from '../helpers/trace.js';

const PRICES = { version: 't', models: { m: {} }, modifiers: {}, serverTools: { priced_custom: {}, 'openai/hosted_custom': {} } } as unknown as PriceTable;
const ROUTES = [{ name: 'r', serverTools: ['listed_custom'] }] as unknown as CompiledRoute[];

const outcome = (type: string, surface = 'anthropic-messages'): RequestOutcome =>
  ({
    id: 'r1',
    key: { hash: 'h', keyId: 'key_1', tenant: 't', team: null, name: 'n', kind: 'developer', billing: 'api' },
    attribution: { session: null, agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null },
    surface,
    features: { model: 'm', stream: false, maxOutputTokens: null, toolCount: 1, thinking: false, serverTools: [{ type, maxUses: 1 }], bodyBytes: 7, prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: false, lastTurn: null },
    provider: null,
    status: 403,
    usage: null,
    aborted: false,
    startedAt: Date.UTC(2026, 10, 3),
    ttfbMs: null,
    totalMs: 1,
    addedTtfbMs: null,
    costMicroUsd: null,
    costBasis: 'billed',
    client: { agent: 'claude-code', version: null },
    policyRevision: 'rev',
    priceTable: 't',
    route: null,
  }) as RequestOutcome;

const traced = (type: string, salt = 'salt', surface?: string): string => buildTraceRecord(outcome(type, surface), salt, { prices: PRICES, routes: ROUTES }).features.serverTools[0]?.type as string;
const exported = (type: string): string => {
  const r = baseRecord();
  return anonymizeRecord({ ...r, instance: 'i', seq: 1, features: { ...r.features, serverTools: [{ type, maxUses: 1 }] } }, saltedPseudonyms('s')).features.serverTools[0]?.type as string;
};

const KNOWN = ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'tool_search_tool_regex_20251119', 'tool_search_tool_bm25', 'mcp_toolset', 'mcp_servers', 'web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'image_generation', 'computer_use_preview', 'mcp', 'shell', '(invalid)'];

test('S-V4-3 a raw trace keeps known server tool types and the ones the recording policy names, in clear', () => {
  for (const t of KNOWN) expect(traced(t)).toBe(t);
  expect(traced('priced_custom')).toBe('priced_custom');
  expect(traced('priced_custom_20260101')).toBe('priced_custom_20260101');
  expect(traced('hosted_custom', 'salt', 'openai-responses')).toBe('hosted_custom');
  expect(traced('listed_custom')).toBe('listed_custom');
});

test('S-V4-3 a raw trace replaces any other server tool type by a bounded placeholder, stable within one trace salt', () => {
  for (const t of ['jane_doe', 'project_falcon_lookup', 'ghp_0000a0aa0a000aa0', 'acme', 'x']) {
    const out = traced(t);
    expect(out).toMatch(/^tool_[0-9a-f]{16}$/);
    expect(out).not.toContain(t);
    expect(traced(t)).toBe(out);
    expect(traced(t, 'other-salt')).not.toBe(out);
  }
});

test('S-V4-3 exports keep only known server tool types; letters-only words are pseudonymised too', () => {
  for (const t of KNOWN) expect(exported(t)).toBe(t);
  for (const t of ['jane_doe', 'project_falcon_lookup', 'listed_custom', 'tool_0123456789abcdef']) {
    expect(exported(t)).toMatch(/^toolType-[0-9a-f]{8}$/);
  }
});

/** Server tool type candidates not drawn from the implementation's shape: letters-only words, identifiers, any string. */
const anyType = fc.oneof(
  fc.stringMatching(/^[a-z]{1,12}(?:_[a-z]{1,12}){0,4}$/),
  fc.stringMatching(/^[a-z0-9_]{1,64}$/),
  fc.string({ maxLength: 80 }),
);
const isKnown = (t: string): boolean => KNOWN.includes(t) || KNOWN.includes(t.replace(/_\d{8}$/, ''));

test('fuzz: any unknown server tool type becomes a placeholder at ingest (exports: test/fuzz/anonymize.fuzz.test.ts)', () => {
  fc.assert(
    fc.property(anyType.filter((t) => !isKnown(t) && !['priced_custom', 'listed_custom'].includes(t.replace(/_\d{8}$/, ''))), (t) => {
      const raw = traced(t);
      expect(raw === '(invalid)' || /^tool_[0-9a-f]{16}$/.test(raw), raw).toBe(true);
      expect(raw).not.toBe(t);
    }),
    fuzz(0x5a43, 500),
  );
});
