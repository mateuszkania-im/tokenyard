import fc from 'fast-check';
import { expect, test } from 'vitest';
import {
  inputTokenBound,
  maxInputRate,
  maxOutputRate,
  modifierProduct,
  OVERHEAD_TOKENS,
  reservationPrice,
  sessionAwareMicroUsd,
  TEXT_BLOCK_TYPES,
  worstCaseMicroUsd,
} from '../../src/limits/estimator.js';
import type { RequestFeatures } from '../../src/policy/types.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { lookupModel, parsePriceTable, type ModelPrice, type PriceTable } from '../../src/pricing/prices.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import type { ExtractedFeatures } from '../../src/surfaces/types.js';
import { loadPrices } from '../helpers/prices.js';

const table = loadPrices();
const opus = table.models['claude-opus-5-5'] as ModelPrice;
const sonnet = table.models['claude-sonnet-5-5'] as ModelPrice;
const opts = { serverToolsWithoutMaxUses: 'block', assumedMaxUses: 20, reserveOutputTokens: null } as const;

const extract = (o: object): ExtractedFeatures => extractAnthropicFeatures(Buffer.from(JSON.stringify(o)));

/** Anthropic-defined client tools (tool reference page): the application runs them, so no provider-side loop. */
const CLIENT_TOOL_TYPES = [
  'bash_20250124', 'text_editor_20250124', 'text_editor_20250728', 'memory_20250818',
  'computer_20250124', 'computer_20251124', 'computer_toolset_20260801', 'browser_toolset_20260801',
] as const;

/** RequestFeatures for an extracted body, with the bound computed the way the edge will compute it. */
function req(x: ExtractedFeatures, m: ModelPrice, over: Partial<RequestFeatures> = {}): RequestFeatures {
  const bound = inputTokenBound(x, m);
  return {
    id: 'r1', ts: 0, surface: 'anthropic-messages', traffic: 'coding-agent', billing: 'api', tenant: 't', team: null, keyId: 'k',
    model: x.model ?? 'unknown', stream: x.stream, inputTokensBound: bound.tokens, boundKind: bound.kind,
    maxOutputTokens: x.maxOutputTokens, serverTools: x.serverTools, toolCount: x.toolCount, thinking: x.thinking, fastMode: x.fastMode,
    attribution: { session: null, agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null },
    guardrail: { hits: [] },
    ...over,
  };
}

/** A text-only Messages body of exactly `bytes` bytes. */
function textBody(bytes: number, extra: object = {}): Buffer {
  const shell = (text: string) => JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 32_000, ...extra, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const b = Buffer.from(shell('a'.repeat(bytes - Buffer.byteLength(shell('')))));
  expect(b.length).toBe(bytes);
  return b;
}

test('constants are the spec values', () => {
  expect(OVERHEAD_TOKENS).toBe(4096);
  expect([...TEXT_BLOCK_TYPES]).toEqual(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result']);
});

test('spec 7.4 example: 150,000-byte text body, max_tokens 32,000, Opus 5.5', () => {
  const x = extractAnthropicFeatures(textBody(150_000));
  expect(inputTokenBound(x, opus)).toEqual({ tokens: 154_096, kind: 'bytes' });
  const f = req(x, opus);
  // input (150_000 + 4096) * 8 = 1_232_768; output 32_000 * 20 = 640_000; * 1.1 = 2_060_044.8
  expect(worstCaseMicroUsd(f, opus, table, opts)).toEqual({ micro: 2_060_045, boundAssumed: false, block: null });
});

test('rates: highest input-side and output rate across tiers, modifier product above 1', () => {
  expect(maxInputRate(opus)).toBe(8);
  expect(maxOutputRate(opus)).toBe(20);
  const haiku = table.models['claude-haiku-5-5'] as ModelPrice;
  expect(maxInputRate(haiku)).toBe(1); // tier cacheWrite1h
  expect(maxOutputRate(haiku)).toBe(2.5); // tier output
  expect(modifierProduct(table)).toBe(1.1);
  const t = parsePriceTable(`
version: x
models: {}
modifiers: { a: 1.5, b: 0.5, c: 2 }
`);
  expect(modifierProduct(t)).toBe(3);
  expect(modifierProduct(parsePriceTable('version: x\nmodels: {}\n'))).toBe(1);
});

test('bytes bound is capped at maxContextTokens', () => {
  const small = { ...opus, maxContextTokens: 10_000 };
  expect(inputTokenBound(extractAnthropicFeatures(textBody(150_000)), small)).toEqual({ tokens: 10_000, kind: 'bytes' });
});

test('image, document, file or url source, mcp_servers, container or unknown block type gives context-window', () => {
  const msg = (content: unknown) => ({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content }] });
  const cases: Record<string, object> = {
    'image url source': msg([{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]),
    'document file source': msg([{ type: 'document', source: { type: 'file', file_id: 'file_1' } }]),
    'image inside tool_result': msg([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', data: '' } }] }]),
    'unknown block type': msg([{ type: 'search_result', source: 'x', title: 't', content: [] }]),
    'server tool result from an earlier turn': msg([{ type: 'web_search_tool_result', tool_use_id: 's', content: [] }]),
    mcp_servers: { ...msg('hi'), mcp_servers: [{ type: 'url', url: 'https://example.com', name: 'a' }] },
    container: { ...msg('hi'), container: 'container_1' },
    'unknown field': { ...msg('hi'), future_field: true },
    'server tool': { ...msg('hi'), tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] },
  };
  for (const [name, body] of Object.entries(cases)) {
    expect(inputTokenBound(extract(body), opus), name).toEqual({ tokens: 1_000_000, kind: 'context-window' });
  }
  const text = msg([
    { type: 'thinking', thinking: 'x', signature: 's' },
    { type: 'redacted_thinking', data: 'x' },
    { type: 'tool_use', id: 't', name: 'Read', input: {} },
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] },
    { type: 'text', text: 'hi' },
  ]);
  expect(inputTokenBound(extract(text), opus).kind).toBe('bytes');
});

test('parse error or missing model gives context-window and is priced at the most expensive model', () => {
  const bad = extractAnthropicFeatures(Buffer.from('{"model":'));
  expect(inputTokenBound(bad, opus)).toEqual({ tokens: 1_000_000, kind: 'context-window' });
  const noModel = extract({ max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] });
  expect(inputTokenBound(noModel, opus).kind).toBe('context-window');

  for (const model of [null, 'claude-nope', '__proto__', 'constructor']) {
    const { price, unpriced } = reservationPrice(table, model);
    expect(unpriced, String(model)).toBe(true);
    // At least as expensive as every priced model in every dimension, fast mode included.
    for (const [id, m] of Object.entries(table.models)) {
      expect(maxInputRate(price), id).toBeGreaterThanOrEqual(maxInputRate(m, true));
      expect(maxOutputRate(price), id).toBeGreaterThanOrEqual(maxOutputRate(m, true));
      expect(price.maxContextTokens).toBeGreaterThanOrEqual(m.maxContextTokens);
      expect(price.maxOutputTokens).toBeGreaterThanOrEqual(m.maxOutputTokens);
    }
  }
  const { price } = reservationPrice(table, null);
  // Fable 5.1: cacheWrite1h 20, output 50; GPT-5.5 and GPT-5.4: the largest context, 1.05M. (1.05e6 * 20 + 1000 * 50) * 1.1
  expect(worstCaseMicroUsd(req(noModel, price), price, table, opts).micro).toBe(23_155_000);
  expect(reservationPrice(table, 'claude-opus-5-5-20261001')).toEqual({ price: opus, unpriced: false });
});

test('web_search max_uses 5: input and output bounds times maxIterations, plus 5 * perUseUsd', () => {
  const x = extract({ model: 'claude-opus-5-5', max_tokens: 32_000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }], messages: [{ role: 'user', content: 'hi' }] });
  // input 10 * 1M * 8 = 80_000_000; output 10 * 128_000 * 20 = 25_600_000; * 1.1 = 116_160_000; fee 5 * 0.01 USD = 50_000
  expect(worstCaseMicroUsd(req(x, opus), opus, table, opts)).toEqual({ micro: 116_210_000, boundAssumed: false, block: null });
});

test('server tool without max_uses: block by default; assume uses assumedMaxUses and sets boundAssumed', () => {
  const x = extract({ model: 'claude-opus-5-5', max_tokens: 1000, tools: [{ type: 'web_search_20260209', name: 'web_search' }], messages: [{ role: 'user', content: 'hi' }] });
  const blocked = worstCaseMicroUsd(req(x, opus), opus, table, opts);
  expect(blocked.block).toBe('server-tool-no-max-uses');
  const assumed = worstCaseMicroUsd(req(x, opus), opus, table, { ...opts, serverToolsWithoutMaxUses: 'assume' });
  expect(assumed).toEqual({ micro: 116_160_000 + 20 * 10_000, boundAssumed: true, block: null });
});

test('an unpriced server tool type is reported, and outranks a missing max_uses', () => {
  const x = extract({
    model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2 }, { type: 'web_search_20250305', name: 'web_search' }],
  });
  const r = worstCaseMicroUsd(req(x, opus), opus, table, opts);
  expect(r.block).toBe('unpriced-server-tool');
  expect(r.boundAssumed).toBe(true);
  // Prototype keys never resolve to a price.
  const proto = req(x, opus, { serverTools: [{ type: 'constructor', maxUses: 1 }] });
  expect(worstCaseMicroUsd(proto, opus, table, opts).block).toBe('unpriced-server-tool');
});

test('MCP connector and unknown tool types take the server-tool path: unpriced, so blocked', () => {
  const base = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] };
  const mcp = extract({ ...base, mcp_servers: [{ type: 'url', url: 'https://example.com/mcp', name: 'gh' }], tools: [{ type: 'mcp_toolset', mcp_server_name: 'gh' }] });
  expect(mcp.serverTools).toEqual([{ type: 'mcp_toolset', maxUses: null }, { type: 'mcp_servers', maxUses: null }]);
  // Both rules apply (no price, no max_uses); an unpriced tool outranks a missing max_uses because it has no bound at all.
  expect(worstCaseMicroUsd(req(mcp, opus), opus, table, opts)).toMatchObject({ block: 'unpriced-server-tool', boundAssumed: true });
  expect(worstCaseMicroUsd(req(mcp, opus), opus, table, { ...opts, serverToolsWithoutMaxUses: 'assume' }).block).toBe('unpriced-server-tool');
  // mcp_servers alone (no toolset entry) still runs the connector loop.
  const servers = extract({ ...base, mcp_servers: [{ type: 'url', url: 'https://example.com/mcp', name: 'gh' }] });
  expect(worstCaseMicroUsd(req(servers, opus), opus, table, opts).block).toBe('unpriced-server-tool');
  // An empty mcp_servers adds no server tool (it still leaves the bytes bound, as an unknown field).
  expect(extract({ ...base, mcp_servers: [] }).serverTools).toEqual([]);
  for (const type of ['future_tool_20270101', 'advisor_20260301']) {
    const x = extract({ ...base, tools: [{ type, name: 'x', max_uses: 3 }] });
    expect(x.serverTools, type).toEqual([{ type, maxUses: 3 }]);
    expect(worstCaseMicroUsd(req(x, opus), opus, table, opts).block, type).toBe('unpriced-server-tool');
  }
  const odd = extract({ ...base, tools: [{ type: 42, name: 'x' }] });
  expect(odd.serverTools).toEqual([{ type: '42', maxUses: null }]);
});

test('custom tools and every known client tool type take the client path', () => {
  const base = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] };
  const custom = extract({ ...base, tools: [{ name: 'Read', input_schema: {} }, { type: 'custom', name: 'B', input_schema: {} }] });
  expect(custom.serverTools).toEqual([]);
  expect(inputTokenBound(custom, opus).kind).toBe('bytes');
  for (const type of CLIENT_TOOL_TYPES) {
    const x = extract({ ...base, tools: [{ type, name: 'x' }] });
    expect(x.serverTools, type).toEqual([]);
    // Hidden definitions can exceed the overhead, so the bound is the context window, one iteration, no block.
    expect(inputTokenBound(x, opus), type).toEqual({ tokens: 1_000_000, kind: 'context-window' });
    expect(worstCaseMicroUsd(req(x, opus), opus, table, opts), type).toEqual({ micro: Math.round((8_000_000 + 20_000) * 1.1), boundAssumed: false, block: null });
  }
});

test('property: any tool set with a server-side tool that has no price is blocked', () => {
  fc.assert(
    fc.property(
      fc.subarray(['custom', ...CLIENT_TOOL_TYPES, 'web_search_20250305']),
      fc.constantFrom('mcp_toolset', 'advisor_20260301', 'web_fetch_20250910', 'code_execution_20250825', 'future_tool_20270101'),
      fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }),
      (others, unpriced, maxUses) => {
        const tools: object[] = others.map((type) => (type === 'custom' ? { name: 'c', input_schema: {} } : { type, name: type, max_uses: 2 }));
        tools.push(maxUses === null ? { type: unpriced, name: 'u' } : { type: unpriced, name: 'u', max_uses: maxUses });
        const x = extract({ model: 'claude-opus-5-5', max_tokens: 10, tools, messages: [] });
        expect(worstCaseMicroUsd(req(x, opus), opus, table, opts).block).toBe('unpriced-server-tool');
      },
    ),
  );
});

test('Responses request without max_output_tokens uses maxOutputTokens', () => {
  const f = req(extract({ model: 'claude-sonnet-5-5', messages: [] }), sonnet, { surface: 'openai-responses', inputTokensBound: 1000, boundKind: 'bytes', maxOutputTokens: null });
  // (1000 * (4 + 4) + 128_000 * 10) * 1.1: on the Responses surface each input token may also be billed as a write.
  expect(worstCaseMicroUsd(f, sonnet, table, opts).micro).toBe(1_416_800);
});

test('reserveOutputTokens caps the output of a product route; max_tokens above the model limit is capped', () => {
  const f = req(extract({ model: 'claude-sonnet-5-5', messages: [] }), sonnet, { inputTokensBound: 1000, boundKind: 'bytes', maxOutputTokens: 50_000 });
  expect(worstCaseMicroUsd(f, sonnet, table, { ...opts, reserveOutputTokens: 4000 }).micro).toBe(48_400);
  const huge = { ...f, maxOutputTokens: 10_000_000 };
  expect(worstCaseMicroUsd(huge, sonnet, table, opts).micro).toBe(1_412_400);
});

test('fast mode: a request with speed "fast" on Opus 5.5 is priced at the fast rates', () => {
  const x = extractAnthropicFeatures(textBody(150_000, { speed: 'fast' }));
  expect(x.fastMode).toBe(true);
  expect(maxInputRate(opus, true)).toBe(16); // fast cacheWrite1h
  expect(maxOutputRate(opus, true)).toBe(40);
  // (154_096 * 16 + 32_000 * 40) * 1.1 = 4_120_089.6
  expect(worstCaseMicroUsd(req(x, opus), opus, table, opts).micro).toBe(4_120_090);
  // A model without fast prices rejects speed "fast" (docs: an error, not billed), so standard rates apply.
  const fs = req({ ...x, model: 'claude-sonnet-5-5' }, sonnet);
  expect(worstCaseMicroUsd(fs, sonnet, table, opts).micro).toBe(1_030_023);
});

test('an estimate that is not a safe integer throws (fail closed)', () => {
  const x = extract({ model: 'claude-opus-5-5', max_tokens: 1, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1e300 }], messages: [] });
  expect(() => worstCaseMicroUsd(req(x, opus), opus, table, opts)).toThrow(/invalid estimate/);
});

test('session-aware: input at the previous cache read share, output min(max_tokens, reserveOutputTokens)', () => {
  const f = req(extract({ model: 'claude-opus-5-5', messages: [] }), opus, { inputTokensBound: 100_000, boundKind: 'bytes', maxOutputTokens: 32_000 });
  // share 0.9: 90_000 * 0.2 + 10_000 * 8 = 98_000; output 8_000 * 20 = 160_000; * 1.1 = 283_800
  expect(sessionAwareMicroUsd(f, opus, table, 0.9, 8000)).toBe(283_800);
  // no previous request: every input token at the highest input-side rate; no reserve cap: max_tokens
  expect(sessionAwareMicroUsd(f, opus, table, null, null)).toBe(1_584_000);
  // out-of-range shares are clamped
  expect(sessionAwareMicroUsd(f, opus, table, 7, 8000)).toBe(sessionAwareMicroUsd(f, opus, table, 1, 8000));
  expect(sessionAwareMicroUsd(f, opus, table, Number.NaN, 8000)).toBe(sessionAwareMicroUsd(f, opus, table, 0, 8000));
  // fast mode uses the fast rates
  expect(sessionAwareMicroUsd({ ...f, fastMode: true }, opus, table, 0, 8000)).toBe(2_112_000);
});

// Property: under the estimator's premises (input within the bound, output within the output bound, searches
// within max_uses), the actual cost with every modifier active, tiers and fast mode never exceeds the reservation.

/** A table with awkward float prices and several modifiers, to stress rounding. */
const stress: PriceTable = parsePriceTable(`
version: x
models:
  claude-odd:
    { input: 0.3, output: 1.7, cacheWrite5m: 0.375, cacheWrite1h: 0.6, cacheRead: 0.03, maxContextTokens: 200000, maxOutputTokens: 64000,
      tiers: [ { aboveInputTokens: 50000, input: 0.7, output: 3.3, cacheWrite5m: 0.875, cacheWrite1h: 1.4, cacheRead: 0.07 } ],
      fast: { input: 1.9, output: 9.1, cacheWrite5m: 2.375, cacheWrite1h: 3.8, cacheRead: 0.19, source: s, retrieved: r },
      source: s, retrieved: r }
modifiers: { geo: 1.1, other: 1.07, discount: 0.9 }
serverTools:
  web_search: { perUseUsd: 0.013, maxIterations: 3, source: s, retrieved: r }
`);

const arbCase = fc
  .record({
    tableName: fc.constantFrom('example', 'stress'),
    modelIndex: fc.nat(),
    fast: fc.boolean(),
    bodyBytes: fc.integer({ min: 2, max: 2_000_000 }),
    textOnly: fc.boolean(),
    maxTokens: fc.option(fc.integer({ min: 1, max: 200_000 }), { nil: null }),
    reserve: fc.option(fc.integer({ min: 1, max: 200_000 }), { nil: null }),
    search: fc.option(fc.integer({ min: 1, max: 50 }), { nil: null }),
    // A tool next to the search tool: none, a custom tool, or an Anthropic client tool. All stay on the client path.
    clientTool: fc.constantFrom(null, 'custom', ...CLIENT_TOOL_TYPES),
    // How the bound is used: fractions of input per bucket, of output, of searches.
    split: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 4, maxLength: 4 }),
    inFrac: fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
    outFrac: fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
    useFrac: fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
  })
  .map((c) => {
    const t = c.tableName === 'example' ? table : stress;
    const ids = Object.keys(t.models);
    const model = ids[c.modelIndex % ids.length] as string;
    const m = t.models[model] as ModelPrice;
    const fast = c.fast && m.fast !== undefined;
    // The tool set goes through the real extractor, so its server or client classification is what is tested.
    const tools: object[] = [];
    if (c.clientTool !== null) tools.push(c.clientTool === 'custom' ? { name: 'Read', input_schema: {} } : { type: c.clientTool, name: 'tool' });
    if (c.search !== null) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: c.search });
    const toolFeatures = extract({ model, max_tokens: 1, tools, messages: [{ role: 'user', content: 'hi' }] });
    const serverTools = toolFeatures.serverTools;
    const x: ExtractedFeatures = {
      model, stream: true, maxOutputTokens: c.maxTokens, toolCount: tools.length, thinking: false, serverTools, bodyBytes: c.bodyBytes,
      prefixHash: null, blockTypes: c.textOnly ? ['text'] : ['image'], expandsServerSide: !c.textOnly || toolFeatures.expandsServerSide,
      parseError: false, lastTurn: null, fastMode: fast,
    };
    const f = req(x, m);
    const iterations = c.search === null ? 1 : (t.serverTools.web_search?.maxIterations ?? 1);
    // The premises: total billed input per request at most bound * iterations; output at most the output bound per iteration.
    const inputTotal = Math.floor((c.search === null ? f.inputTokensBound : m.maxContextTokens * iterations) * c.inFrac);
    const outCap = c.search === null ? Math.min(c.maxTokens ?? m.maxOutputTokens, c.reserve ?? Infinity, m.maxOutputTokens) : m.maxOutputTokens * iterations;
    const w = c.split.map((s) => s + 1e-9);
    const sum = w.reduce((a, b) => a + b, 0);
    const parts = w.map((s) => Math.floor((inputTotal * s) / sum));
    const u = { input: parts[0] ?? 0, cacheWrite5m: parts[1] ?? 0, cacheWrite1h: parts[2] ?? 0, cacheRead: parts[3] ?? 0, output: Math.floor(outCap * c.outFrac) };
    const uses = c.search === null ? 0 : Math.floor(c.search * c.useFrac);
    return { t, model, m, f, u, fast, uses, reserve: c.reserve };
  });

test('property: any usage with input <= bound and output <= max_tokens costs <= the reservation', () => {
  fc.assert(
    fc.property(arbCase, ({ t, model, m, f, u, fast, uses, reserve }) => {
      const allModifiers = { modifiers: Object.keys(t.modifiers), fast, serverToolUses: uses > 0 ? { web_search: uses } : ({} as Record<string, number>) };
      const est = worstCaseMicroUsd(f, m, t, { ...opts, reserveOutputTokens: reserve });
      expect(est.block).toBeNull();
      expect(costMicroUsd(t, model, u, allModifiers)).toBeLessThanOrEqual(est.micro);
    }),
    { numRuns: 3000 },
  );
});

test('property edge: every input token at the top rate and full output equals the reservation, never one over', () => {
  // All input as 1h cache writes at the bound and output at max_tokens: cost (rounded half up) must not exceed the ceil.
  for (const t of [table, stress]) {
    for (const [model, m] of Object.entries(t.models)) {
      for (const fast of m.fast ? [false, true] : [false]) {
        for (const bytes of [1, 7, 99_999, 333_333, 10_000_000]) {
          for (const out of [1, 3, 31_999, 32_000, 64_000]) {
            const x: ExtractedFeatures = {
              model, stream: true, maxOutputTokens: out, toolCount: 0, thinking: false, serverTools: [], bodyBytes: bytes,
              prefixHash: null, blockTypes: ['text'], expandsServerSide: false, parseError: false, lastTurn: null, fastMode: fast,
            };
            const f = req(x, m);
            const u = { input: 0, cacheWrite5m: 0, cacheRead: 0, cacheWrite1h: f.inputTokensBound, output: Math.min(out, m.maxOutputTokens) };
            const cost = costMicroUsd(t, model, u, { modifiers: Object.keys(t.modifiers), fast });
            expect(cost, `${model} ${fast} ${bytes} ${out}`).toBeLessThanOrEqual(worstCaseMicroUsd(f, m, t, opts).micro);
          }
        }
      }
    }
  }
});

test('fix 3: on the Responses surface the worst case covers cache writes billed on top of input (up to every prompt token)', () => {
  const table = loadPrices();
  const lookup = lookupModel(table, 'gpt-5.4');
  if (!lookup) throw new Error('gpt-5.4 is not priced');
  const m = lookup.price;
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 300_000 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 1, max: 128_000 }), (bytes, cachedShare, writeShare, out) => {
      const x = { ...extract({ model: 'gpt-5.4', max_tokens: out, messages: [{ role: 'user', content: 'x' }] }), bodyBytes: bytes };
      const f = { ...req(x, m), surface: 'openai-responses' as const, maxOutputTokens: out };
      const est = worstCaseMicroUsd(f, m, table, opts).micro;
      // input_tokens up to the bound; cached part of it; writes up to all of it, billed on top.
      const inputTokens = f.inputTokensBound;
      const cached = Math.floor(inputTokens * cachedShare);
      const written = Math.floor(inputTokens * writeShare);
      const cost = costMicroUsd(table, 'gpt-5.4', { input: inputTokens - cached, cacheRead: cached, cacheWrite5m: written, cacheWrite1h: 0, output: out });
      expect(cost).toBeLessThanOrEqual(est);
    }),
    { numRuns: 300 },
  );
});
