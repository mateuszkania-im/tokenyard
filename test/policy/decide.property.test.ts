import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { resolve } from '../../src/policy/resolve.js';
import type { Admission, GuardrailHit, RequestFeatures } from '../../src/policy/types.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';
import { HEAD, source } from './helpers.js';

const policy = compilePolicy(
  source(`${HEAD}routes:
  - { name: cc, match: { surface: anthropic-messages, traffic: coding-agent }, chain: [{ provider: a, weight: 2 }, { provider: b, weight: 1 }], allowModels: ["claude-*"] }
  - { name: by-team, match: { team: data, model: "claude-haiku-*" }, chain: [b] }
  - { name: prod, match: { traffic: product }, chain: [c], rewriteModel: claude-haiku-5-5 }
budgets:
  - { name: org, scope: tenant, window: month, usd: 100 }
  - { name: team, scope: team, window: day, usd: 10 }
  - { name: key, scope: key, window: week, usd: 5, mode: audit }
  - { name: repo, scope: repo, window: day, usd: 3 }
  - { name: session, scope: session, usd: 2, onExceed: warn }
rateLimits:
  - { name: rpm, scope: key, rpm: 90, burst: 4 }
  - { name: streams, scope: team, concurrentStreams: 3 }
failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
  unpricedModel: allow-and-flag
`),
  'prop',
  { experimentalSubscription: false },
);

const maybe = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | null> => fc.option(a, { nil: null });
const word = fc.constantFrom('web', 'data', 'acme', '__proto__', 'constructor', 'x:y', 'a}b');

const hit: fc.Arbitrary<GuardrailHit> = fc.record({
  rule: fc.constantFrom('aws', 'gh', 'jwt'),
  action: fc.constantFrom('block', 'warn', 'redact'),
  valueHmac: fc.stringMatching(/^[0-9a-f]{4,8}$/),
  where: fc.constantFrom('last-turn', 'history'),
});

const featuresArb: fc.Arbitrary<RequestFeatures> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  ts: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  surface: fc.constantFrom('anthropic-messages', 'anthropic-count-tokens', 'openai-responses', 'openai-chat'),
  traffic: fc.constantFrom('coding-agent', 'product'),
  billing: fc.constant('api' as const),
  tenant: word,
  team: maybe(word),
  keyId: word,
  model: fc.constantFrom('', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5-20261101', 'gpt-5', 'claude-mystery'),
  stream: fc.boolean(),
  inputTokensBound: fc.integer({ min: 0, max: 1_000_000 }),
  boundKind: fc.constantFrom('bytes', 'context-window'),
  maxOutputTokens: maybe(fc.integer({ min: 1, max: 200_000 })),
  serverTools: fc.array(fc.record({ type: fc.constantFrom('web_search_20250305', 'code_execution_20250825'), maxUses: maybe(fc.integer({ min: 0, max: 50 })) }), { maxLength: 2 }),
  toolCount: fc.nat(40),
  thinking: fc.boolean(),
  fastMode: fc.boolean(),
  attribution: fc.record({
    session: maybe(word), agent: maybe(word), parentAgent: maybe(word),
    requestClass: maybe(fc.constantFrom('main', 'subagent', 'workflow', 'compaction', 'auxiliary')),
    agentType: maybe(word), promptId: maybe(word), repo: maybe(word), branch: maybe(word), ticket: maybe(word), feature: maybe(word),
  }),
  guardrail: fc.record({ hits: fc.array(hit, { maxLength: 3 }) }),
});

const admissionArb: fc.Arbitrary<Admission | null> = maybe(
  fc.record({
    admitted: fc.boolean(),
    failed: maybe(
      fc.record({
        kind: fc.constantFrom('budget', 'rate', 'streams', 'taint'),
        name: fc.constantFrom('org', 'team', 'rpm', 'streams', 'nope', '__proto__'),
        spentMicroUsd: fc.nat(),
        retryAfterMs: fc.integer({ min: -10, max: 10_000_000 }),
        rule: fc.constantFrom('aws', 'gh'),
      }),
    ),
    audit: fc.array(fc.record({ name: fc.constantFrom('key', 'session'), wouldFail: fc.boolean() }), { maxLength: 2 }),
    totals: fc.constant([] as Admission['totals']),
    storeDown: fc.constantFrom(undefined, true as const),
  }).map((a) => {
    const { storeDown, ...rest } = a;
    return storeDown ? { ...rest, storeDown } : rest;
  }),
);

test('property: decide and resolve return deep-equal results for the same arguments', () => {
  fc.assert(
    fc.property(featuresArb, admissionArb, (f, a) => {
      const p1 = decide(policy, f);
      const p2 = decide(policy, structuredClone(f));
      expect(p2).toEqual(p1);
      const d1 = resolve(policy, p1, a);
      const d2 = resolve(policy, structuredClone(p1), structuredClone(a));
      expect(d2).toEqual(d1);
      // Retry-after is never above 60 seconds and always an integer.
      const s = d1.block?.retryAfterS;
      if (s !== null && s !== undefined) expect(Number.isInteger(s) && s >= 0 && s <= 60).toBe(true);
      // Every counter key carries the tenant hash tag.
      const keys = [...p1.reservations, ...p1.rateChecks, ...p1.streamSlots].map((r) => r.key).concat(p1.taint ? [p1.taint.key] : []);
      for (const k of keys) expect(k.startsWith(`ty:{${encodeURIComponent(f.tenant)}}:`)).toBe(true);
    }),
    { numRuns: 500 },
  );
});

test('property: decide reads no clock (same features at different wall times give the same plan)', () => {
  fc.assert(
    fc.property(featuresArb, (f) => {
      const realNow = Date.now;
      try {
        Date.now = () => 0;
        const a = decide(policy, f);
        Date.now = () => 9_999_999_999_999;
        expect(decide(policy, f)).toEqual(a);
      } finally {
        Date.now = realNow;
      }
    }),
    { numRuns: 100 },
  );
});

// V4: purity against a frozen snapshot. The compiled policy is frozen all the way down; decide and resolve run on
// deeply frozen inputs (a write would throw in strict mode), give what they give on unfrozen copies, and return
// results that share nothing mutable with the policy or with each other.
function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const c of Object.values(v)) deepFreeze(c);
  }
  return v;
}

/** Every object reachable from `v` (Map keys and values included) is frozen, and every Map refuses writes. */
function expectDeepFrozen(v: unknown, path = 'policy', seen = new Set<unknown>()): void {
  if (typeof v !== 'object' || v === null || seen.has(v)) return;
  seen.add(v);
  expect(Object.isFrozen(v), path).toBe(true);
  if (v instanceof Map) {
    expect(() => (v as Map<unknown, unknown>).set('x', 1), `${path}.set`).toThrow();
    for (const [k, x] of v) {
      expectDeepFrozen(k, `${path} key`, seen);
      expectDeepFrozen(x, `${path}[${String(k)}]`, seen);
    }
    return;
  }
  for (const [k, x] of Object.entries(v)) expectDeepFrozen(x, `${path}.${k}`, seen);
}

/** Walks every mutable object in `v`, overwriting its fields and emptying arrays, to show nothing it shares changes. */
function vandalise(v: unknown, seen = new Set<unknown>()): void {
  if (typeof v !== 'object' || v === null || Object.isFrozen(v) || seen.has(v)) return;
  seen.add(v);
  for (const [k, x] of Object.entries(v)) {
    vandalise(x, seen);
    (v as Record<string, unknown>)[k] = Array.isArray(x) ? [] : '__vandalised__';
  }
  if (Array.isArray(v)) v.length = 0;
}

test('property: the compiled policy is frozen all the way down (examples and the property policy)', () => {
  expectDeepFrozen(policy);
  expectDeepFrozen(compilePolicy(source(readFileSync(new URL('../../examples/policy/policy.yaml', import.meta.url), 'utf8')), 'ex', { experimentalSubscription: false }));
});

test('property: decide and resolve on deeply frozen inputs equal the unfrozen run, and their results alias nothing', () => {
  fc.assert(
    fc.property(featuresArb, admissionArb, (f, a) => {
      const plain = resolve(policy, decide(policy, structuredClone(f)), structuredClone(a));
      const frozenF = deepFreeze(structuredClone(f));
      const frozenA = deepFreeze(structuredClone(a));
      const p = decide(policy, frozenF);
      const d = resolve(policy, p, frozenA);
      expect(d).toEqual(plain);
      // A second run after vandalising the first results gives the same answer: no shared mutable state.
      const keep = structuredClone(d);
      vandalise(d);
      vandalise(p);
      expect(resolve(policy, decide(policy, frozenF), frozenA)).toEqual(keep);
      // A frozen plan is fine as resolve input too.
      expect(resolve(policy, deepFreeze(decide(policy, frozenF)), frozenA)).toEqual(keep);
    }),
    fuzz(0xdec1, 400),
  );
}, fuzzTimeout(10_000));
