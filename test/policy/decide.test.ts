import { expect, test } from 'vitest';
import { anthropicError } from '../../src/edge/errors.js';
import { inputTokenBound, reservationPrice, worstCaseMicroUsd } from '../../src/limits/estimator.js';
import { budgetKey } from '../../src/limits/keys.js';
import { attachCandidate, compilePolicy, PolicyInvalidError } from '../../src/policy/compile.js';
import { buildFeatures, decide } from '../../src/policy/decide.js';
import { modelsForKey } from '../../src/policy/match.js';
import { resolve } from '../../src/policy/resolve.js';
import type { Admission, CompiledPolicy, KeyRecord, Plan } from '../../src/policy/types.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { features, HEAD, source, TS } from './helpers.js';

const compile = (yaml: string, flag = false, revision = 'r1'): CompiledPolicy => compilePolicy(source(yaml), revision, { experimentalSubscription: flag });
const STORE = 'failure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n  unpricedModel: allow-and-flag\n';

const MATCHING = `${HEAD}routes:
  - { name: by-surface, match: { surface: anthropic-count-tokens }, chain: [a] }
  - { name: by-traffic, match: { traffic: product }, chain: [a] }
  - { name: by-billing, match: { billing: subscription }, chain: [a] }
  - { name: by-tenant, match: { tenant: other }, chain: [a] }
  - { name: by-team, match: { team: data }, chain: [a] }
  - { name: by-class, match: { requestClass: compaction }, chain: [a] }
  - { name: by-agent, match: { agentType: Explore }, chain: [a] }
  - { name: by-repo, match: { repo: acme/web }, chain: [a] }
  - { name: by-feature, match: { feature: summary }, chain: [a] }
  - { name: by-model, match: { model: "claude-haiku-*" }, chain: [b] }
  - { name: fallback, chain: [c] }
`;

test('first matching route wins over surface, traffic, billing, team, requestClass, agentType, repo, feature, model glob', () => {
  const p = compile(MATCHING, true);
  const route = (f: Parameters<typeof features>[0]): string | null => decide(p, features(f)).route;
  expect(route({})).toBe('fallback');
  expect(route({ surface: 'anthropic-count-tokens' })).toBe('by-surface');
  expect(route({ traffic: 'product' })).toBe('by-traffic');
  expect(route({ billing: 'subscription' })).toBe('by-billing');
  expect(route({ tenant: 'other' })).toBe('by-tenant');
  expect(route({ team: 'data' })).toBe('by-team');
  expect(route({ attribution: { requestClass: 'compaction' } })).toBe('by-class');
  expect(route({ attribution: { agentType: 'Explore' } })).toBe('by-agent');
  expect(route({ attribution: { repo: 'acme/web' } })).toBe('by-repo');
  expect(route({ attribution: { feature: 'summary' } })).toBe('by-feature');
  expect(route({ model: 'claude-haiku-5-5' })).toBe('by-model');
  expect(route({ model: 'claude-haiku-5-5-20261101' })).toBe('by-model');
  expect(route({ model: 'xclaude-haiku-5-5' })).toBe('fallback'); // anchored
  // Two conditions hold: the earlier route wins.
  expect(route({ team: 'data', model: 'claude-haiku-5-5' })).toBe('by-team');
  expect(route({ attribution: { feature: 'summary', repo: 'acme/web' } })).toBe('by-repo');
  const plan = decide(p, features({ model: 'claude-haiku-5-5' }));
  expect(plan.chain).toEqual([{ provider: 'b', upstreamModel: 'claude-haiku-5-5', rewritesModel: false }]);
  expect(plan.policyRevision).toBe('r1');
});

test('a route matching anthropic-messages also serves count_tokens, with no reservation, rate check or stream slot', () => {
  const p = compile(`${HEAD}routes:
  - { name: msgs, match: { surface: anthropic-messages }, chain: [a] }
budgets:
  - { name: org, scope: tenant, window: day, usd: 10 }
rateLimits:
  - { name: rpm, scope: key, rpm: 60 }
  - { name: st, scope: key, concurrentStreams: 2 }
${STORE}`);
  const plan = decide(p, features({ surface: 'anthropic-count-tokens' }));
  expect(plan).toMatchObject({ route: 'msgs', preBlock: null, reservations: [], rateChecks: [], streamSlots: [] });
  expect(decide(p, features()).reservations).toHaveLength(1);
});

const ALLOW = `${HEAD}routes:
  - name: cc
    match: { surface: anthropic-messages, traffic: coding-agent }
    chain: [a]
    allowModels: ["claude-opus-5-5*"]
${STORE}`;

test('model outside allowModels gives preBlock model-not-allowed and resolve returns 403 permission_error', () => {
  const p = compile(ALLOW);
  expect(decide(p, features({ model: 'claude-opus-5-5-20261101' })).preBlock).toBeNull();
  const plan = decide(p, features({ model: 'claude-sonnet-5-5' }));
  expect(plan).toMatchObject({ route: 'cc', preBlock: 'model-not-allowed', reservations: [] });
  const d = resolve(p, plan, null);
  expect(d).toMatchObject({ action: 'block', block: { status: 403, type: 'permission_error', reason: 'model-not-allowed', retryAfterS: null } });
  expect(d.block?.message).toContain('"cc"');
  // A missing model (parse error) is never allowed by a pattern.
  expect(decide(p, features({ model: '' })).preBlock).toBe('model-not-allowed');
});

test('no route gives preBlock no-route and 403', () => {
  const p = compile(`${HEAD}routes:\n  - { name: product, match: { traffic: product }, chain: [a] }\n${STORE}`);
  const plan = decide(p, features());
  expect(plan).toMatchObject({ route: null, chain: [], preBlock: 'no-route', reservations: [], rateChecks: [], streamSlots: [] });
  expect(resolve(p, plan, null)).toMatchObject({ action: 'block', block: { status: 403, type: 'permission_error', reason: 'no-route', retryAfterS: null } });
});

const BUDGETS = `${HEAD}routes:
  - { name: all, chain: [a] }
budgets:
  - { name: org-month, scope: tenant, window: month, usd: 6000 }
  - { name: team-day, scope: team, window: day, usd: 300 }
  - { name: key-week, scope: key, window: week, usd: 40 }
  - { name: repo-day, scope: repo, window: day, usd: 20 }
  - { name: session, scope: session, usd: 25 }
  - { name: audit-day, scope: key, window: day, usd: 5, mode: audit }
  - { name: warn-day, scope: team, window: day, usd: 5, onExceed: warn }
rateLimits:
  - { name: dev-rpm, scope: key, rpm: 120, burst: 30 }
  - { name: team-rpm, scope: team, rpm: 7 }
  - { name: dev-streams, scope: key, concurrentStreams: 8 }
${STORE}`;

test('reservations cover tenant, team, key, repo and session levels with budgetKey and window start in UTC', () => {
  const p = compile(BUDGETS);
  const f = features({ attribution: { session: 's1', repo: 'acme/web' } });
  const plan = decide(p, f);
  const est = worstCaseMicroUsd(f, reservationPrice(p.prices, 'claude-opus-5-5').price, p.prices, {
    serverToolsWithoutMaxUses: 'block', assumedMaxUses: 25, reserveOutputTokens: null,
  }).micro;
  expect(est).toBeGreaterThan(0);
  expect(plan.preBlock).toBeNull();
  expect(plan.reservations).toEqual([
    { budget: 'org-month', key: 'ty:{acme}:b:org-month:acme:2026-11-01', limitMicroUsd: 6_000_000_000, estMicroUsd: est, enforce: true, resetsAt: '2026-12-01T00:00:00.000Z' },
    { budget: 'team-day', key: 'ty:{acme}:b:team-day:web:2026-11-04', limitMicroUsd: 300_000_000, estMicroUsd: est, enforce: true, resetsAt: '2026-11-05T00:00:00.000Z' },
    { budget: 'key-week', key: 'ty:{acme}:b:key-week:k1:2026-11-02', limitMicroUsd: 40_000_000, estMicroUsd: est, enforce: true, resetsAt: '2026-11-09T00:00:00.000Z' },
    { budget: 'repo-day', key: 'ty:{acme}:b:repo-day:acme%2Fweb:2026-11-04', limitMicroUsd: 20_000_000, estMicroUsd: est, enforce: true, resetsAt: '2026-11-05T00:00:00.000Z' },
    { budget: 'session', key: 'ty:{acme}:b:session:s1', limitMicroUsd: 25_000_000, estMicroUsd: est, enforce: true, resetsAt: null },
    { budget: 'audit-day', key: 'ty:{acme}:b:audit-day:k1:2026-11-04', limitMicroUsd: 5_000_000, estMicroUsd: est, enforce: false, resetsAt: '2026-11-05T00:00:00.000Z' },
    { budget: 'warn-day', key: 'ty:{acme}:b:warn-day:web:2026-11-04', limitMicroUsd: 5_000_000, estMicroUsd: est, enforce: false, resetsAt: '2026-11-05T00:00:00.000Z' },
  ]);
  expect(plan.reservations.every((r) => r.key.startsWith('ty:{acme}:'))).toBe(true);
  expect(plan.rateChecks).toEqual([
    { limit: 'dev-rpm', key: 'ty:{acme}:g:dev-rpm:k1', emissionMs: 500, burst: 30, quantity: 1 },
    { limit: 'team-rpm', key: 'ty:{acme}:g:team-rpm:web', emissionMs: 8572, burst: 1, quantity: 1 },
  ]);
  expect(plan.streamSlots).toEqual([{ limit: 'dev-streams', key: 'ty:{acme}:st:dev-streams:k1', max: 8 }]);

  // Levels without a scope value are skipped: no team, no repo, no session.
  const bare = decide(p, features({ team: null }));
  expect(bare.reservations.map((r) => r.budget)).toEqual(['org-month', 'key-week', 'audit-day']);
  expect(bare.rateChecks.map((r) => r.limit)).toEqual(['dev-rpm']);

  // Window start is UTC: 23:59 on Sunday 1 November in UTC is still in the week of 26 October.
  const late = decide(p, features({ ts: Date.UTC(2026, 10, 1, 23, 59, 59, 999) }));
  expect(late.reservations.find((r) => r.budget === 'key-week')?.key).toBe('ty:{acme}:b:key-week:k1:2026-10-26');
  expect(late.reservations.find((r) => r.budget === 'team-day')?.key).toBe('ty:{acme}:b:team-day:web:2026-11-01');
});

test('budgetKey always carries the tenant hash tag and escapes separators', () => {
  expect(budgetKey('acme', 'team-day', 'web', '2026-11-02')).toBe('ty:{acme}:b:team-day:web:2026-11-02');
  expect(budgetKey('acme', 'session', 's1', null)).toBe('ty:{acme}:b:session:s1');
  expect(budgetKey('a}b', 'x:y', 'v{w', null)).toBe('ty:{a%7Db}:b:x%3Ay:v%7Bw');
  expect(budgetKey('a', 'b:c', 'd', null)).not.toBe(budgetKey('a', 'b', 'c:d', null));
});

test('audit-mode budget appears with enforce false', () => {
  const p = compile(BUDGETS);
  const plan = decide(p, features());
  expect(plan.reservations.find((r) => r.budget === 'audit-day')).toMatchObject({ enforce: false });
  expect(plan.reservations.find((r) => r.budget === 'org-month')).toMatchObject({ enforce: true });
});

const WEIGHTED = `${HEAD}routes:
  - name: split
    chain: [{ provider: a, weight: 1 }, { provider: b, weight: 1 }]
${STORE}`;

test('weighted chain picks by hash of session id, stable across calls', () => {
  const p = compile(WEIGHTED);
  const firsts = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const session = `session-${i}`;
    const one = decide(p, features({ id: `req_${i}`, attribution: { session } })).chain;
    const two = decide(p, features({ id: `other_${i}`, attribution: { session } })).chain;
    expect(two).toEqual(one); // same session, different request: same choice
    expect(one.map((c) => c.provider).sort()).toEqual(['a', 'b']); // the rest stays as fallback
    firsts.add(one[0]?.provider ?? '');
  }
  expect([...firsts].sort()).toEqual(['a', 'b']);
  // Without a session the request id is the seed.
  const byId = (id: string): string | undefined => decide(p, features({ id })).chain[0]?.provider;
  expect(byId('req_x')).toBe(byId('req_x'));
});

test('a weight of zero is never picked first', () => {
  const p = compile(`${HEAD}routes:\n  - name: split\n    chain: [{ provider: a, weight: 0 }, { provider: b, weight: 3 }]\n${STORE}`);
  for (let i = 0; i < 32; i++) expect(decide(p, features({ attribution: { session: `s${i}` } })).chain.map((c) => c.provider)).toEqual(['b', 'a']);
});

const plan0 = (p: CompiledPolicy): Plan => decide(p, features({ attribution: { session: 's1' } }));
const admission = (failed: Admission['failed'], extra: Partial<Admission> = {}): Admission => ({ admitted: failed === null, failed, audit: [], totals: [], ...extra });

test('resolve maps budget failure to 429 rate_limit_error without retry-after; rate to 429 with integer retry-after <= 60; streams to 429 retry-after 1; taint and secret to 400; store-down closed to 503 retry-after 5', () => {
  const p = compile(BUDGETS);
  const plan = plan0(p);
  expect(resolve(p, plan, admission(null))).toMatchObject({ action: 'forward', block: null });
  expect(resolve(p, plan, null)).toMatchObject({ action: 'forward', block: null });

  const budget = resolve(p, plan, admission({ kind: 'budget', name: 'team-day', spentMicroUsd: 299_000_000 }));
  expect(budget).toMatchObject({ action: 'block', block: { status: 429, type: 'rate_limit_error', reason: 'budget', retryAfterS: null } });
  expect(budget.block?.message).toContain('team-day');
  expect(budget.block?.message).toContain('2026-11-05T00:00:00.000Z');

  const rate = (ms: number): number | null | undefined => resolve(p, plan, admission({ kind: 'rate', name: 'dev-rpm', retryAfterMs: ms })).block?.retryAfterS;
  expect(resolve(p, plan, admission({ kind: 'rate', name: 'dev-rpm', retryAfterMs: 1500 }))).toMatchObject({ block: { status: 429, type: 'rate_limit_error', reason: 'rate', retryAfterS: 2 } });
  expect(rate(1)).toBe(1);
  expect(rate(0)).toBe(1);
  expect(rate(600_000)).toBe(60);
  expect(rate(Number.NaN)).toBe(60);
  for (const ms of [1, 999, 1000, 59_001, 60_000, 61_000, 1e12]) {
    const s = rate(ms);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeLessThanOrEqual(60);
  }

  expect(resolve(p, plan, admission({ kind: 'streams', name: 'dev-streams' }))).toMatchObject({ block: { status: 429, type: 'rate_limit_error', reason: 'streams', retryAfterS: 1 } });

  const taint = resolve(p, plan, admission({ kind: 'taint', name: 'taint', rule: 'aws-access-key' }));
  expect(taint).toMatchObject({ block: { status: 400, type: 'invalid_request_error', reason: 'taint', retryAfterS: null } });
  expect(taint.block?.message).toContain('aws-access-key');
  expect(taint.block?.message).toContain('/clear');

  const secretPlan = decide(p, features({ attribution: { session: 's1' }, guardrail: { hits: [{ rule: 'github-pat', action: 'block', valueHmac: 'h1', where: 'last-turn' }] } }));
  expect(secretPlan.preBlock).toBe('secret');
  const secret = resolve(p, secretPlan, null);
  expect(secret).toMatchObject({ block: { status: 400, type: 'invalid_request_error', reason: 'secret', retryAfterS: null } });
  expect(secret.block?.message).toContain('github-pat');
  expect(secret.block?.message).not.toContain('h1');

  const down = admission(null, { admitted: true, storeDown: true });
  expect(resolve(p, plan, down)).toMatchObject({ action: 'block', block: { status: 503, type: 'api_error', reason: 'store-down', retryAfterS: 5 } });
  const open = compile(BUDGETS.replace('budgets: closed', 'budgets: open'));
  expect(resolve(open, plan0(open), down)).toMatchObject({ action: 'forward' });
  const rateClosed = compile(BUDGETS.replace('rateLimits: open, budgets: closed', 'rateLimits: closed, budgets: open'));
  expect(resolve(rateClosed, plan0(rateClosed), down)).toMatchObject({ block: { status: 503, reason: 'store-down', retryAfterS: 5 } });
});

test('anthropicError never emits a retry-after above 60', () => {
  expect(anthropicError(429, 'rate_limit_error', 'x', 3600, 'id').headers['retry-after']).toBe('60');
  expect(anthropicError(429, 'rate_limit_error', 'x', 1.2, 'id').headers['retry-after']).toBe('2');
  expect(anthropicError(429, 'rate_limit_error', 'x', null, 'id').headers['retry-after']).toBeUndefined();
});

test('taint plan: session key, history hits checked, last-turn block hits added, ttl from taintTtlHours', () => {
  const p = compile(BUDGETS);
  expect(decide(p, features()).taint).toBeNull();
  const withSession = decide(p, features({ attribution: { session: 's1' } }));
  expect(withSession.taint).toEqual({ key: 'ty:{acme}:taint:s1', check: [], add: [], ttlMs: 24 * 3_600_000 });
  const hits = decide(p, features({
    guardrail: {
      hits: [
        { rule: 'aws', action: 'block', valueHmac: 'h-hist', where: 'history' },
        { rule: 'gh', action: 'block', valueHmac: 'h-last', where: 'last-turn' },
        { rule: 'entropy', action: 'warn', valueHmac: 'h-warn', where: 'last-turn' },
      ],
    },
  }));
  expect(hits.taint).toEqual({ key: 'ty:{acme}:taint:k1', check: ['h-hist'], add: [{ rule: 'gh', valueHmac: 'h-last' }], ttlMs: 24 * 3_600_000 });
  expect(hits.preBlock).toBe('secret');
  expect(hits.reservations).toEqual([]);
  expect(hits.warnings).toEqual([{ kind: 'guardrail', rule: 'entropy', where: 'last-turn' }]);
});

test('candidate policy produces its own plan for the trace', () => {
  const active = compile(ALLOW, false, 'active');
  const candidate = compile(`${HEAD}routes:\n  - { name: open, chain: [b] }\n${STORE}`, false, 'cand');
  const both = attachCandidate(active, candidate);
  expect(Object.isFrozen(both)).toBe(true);
  const f = features({ model: 'claude-sonnet-5-5' });
  const mine = decide(both, f);
  const theirs = decide(both.candidate as CompiledPolicy, f);
  expect(mine).toMatchObject({ policyRevision: 'active', route: 'cc', preBlock: 'model-not-allowed' });
  expect(theirs).toMatchObject({ policyRevision: 'cand', route: 'open', preBlock: null, chain: [{ provider: 'b' }] });
  expect(resolve(both.candidate as CompiledPolicy, theirs, null).action).toBe('forward');
});

test('unknown, missing or unparseable model: features and reservation priced with reservationPrice(t, null), never the requested name', () => {
  const p = compile(BUDGETS);
  const key: KeyRecord = { hash: 'h', keyId: 'k1', tenant: 'acme', team: 'web', name: 'alice', kind: 'developer', billing: 'api' };
  const raw = { session: null, agent: null, parentAgent: null, requestClass: 'subagent', agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null };
  const envelope = reservationPrice(p.prices, null).price;
  for (const body of [
    { model: 'claude-mystery-9', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  ]) {
    const x = extractAnthropicFeatures(Buffer.from(JSON.stringify(body)));
    const f = buildFeatures(x, key, raw, [], p.prices, 'req_9', TS, 'anthropic-messages');
    const bound = inputTokenBound(x, envelope);
    expect(f).toMatchObject({ inputTokensBound: bound.tokens, boundKind: bound.kind, tenant: 'acme', team: 'web', keyId: 'k1', traffic: 'coding-agent', ts: TS, id: 'req_9' });
    expect(f.attribution.requestClass).toBe('subagent');
    const plan = decide(p, f);
    const est = worstCaseMicroUsd(f, envelope, p.prices, { serverToolsWithoutMaxUses: 'block', assumedMaxUses: 25, reserveOutputTokens: null }).micro;
    expect(plan.reservations[0]?.estMicroUsd).toBe(est);
    expect(plan.warnings).toContainEqual({ kind: 'unpriced', model: f.model });
  }
  const garbled = extractAnthropicFeatures(Buffer.from('{"model":"claude-haiku-5-5", nope'));
  const g = buildFeatures(garbled, key, { ...raw, requestClass: 'bogus' }, [], p.prices, 'r', TS, 'anthropic-messages');
  expect(g).toMatchObject({ model: '', boundKind: 'context-window', inputTokensBound: envelope.maxContextTokens });
  expect(g.attribution.requestClass).toBeNull();
  expect(buildFeatures(garbled, { ...key, kind: 'service' }, raw, [], p.prices, 'r', TS, 'anthropic-messages').traffic).toBe('product');

  // unpricedModel: block (or unstated) refuses the unknown model with 403.
  const strict = compile(BUDGETS.replace('unpricedModel: allow-and-flag', 'unpricedModel: block'));
  const blocked = decide(strict, features({ model: 'claude-mystery-9' }));
  expect(blocked.preBlock).toBe('unpriced');
  expect(resolve(strict, blocked, null).block).toMatchObject({ status: 403, type: 'permission_error' });
});

test('server tools: no max_uses blocks only when an enforced budget is touched; unpriced tools follow failure.unpricedModel', () => {
  const p = compile(BUDGETS);
  const noMax = features({ serverTools: [{ type: 'web_search_20250305', maxUses: null }], boundKind: 'context-window', inputTokensBound: 1_000_000 });
  const plan = decide(p, noMax);
  expect(plan.preBlock).toBe('server-tool-no-max-uses');
  expect(resolve(p, plan, null).block).toMatchObject({ status: 403, type: 'permission_error', reason: 'server-tool-no-max-uses' });

  const auditOnly = compile(`${HEAD}routes:\n  - { name: all, chain: [a] }\nbudgets:\n  - { name: d, scope: key, window: day, usd: 5, mode: audit }\n${STORE}`);
  const soft = decide(auditOnly, noMax);
  expect(soft.preBlock).toBeNull();
  expect(soft.warnings).toContainEqual({ kind: 'bound-assumed', reason: 'server-tool-no-max-uses' });

  const assume = compile(`${BUDGETS}reservation:\n  serverToolsWithoutMaxUses: assume\n`);
  const assumed = decide(assume, noMax);
  expect(assumed.preBlock).toBeNull();
  expect(assumed.warnings).toContainEqual({ kind: 'bound-assumed', reason: 'server-tool-no-max-uses' });

  const unpricedTool = features({ serverTools: [{ type: 'code_execution_20250825', maxUses: 3 }], boundKind: 'context-window', inputTokensBound: 1_000_000 });
  const flagged = decide(p, unpricedTool);
  expect(flagged.preBlock).toBeNull();
  expect(flagged.warnings).toContainEqual({ kind: 'bound-assumed', reason: 'unpriced-server-tool' });
  const strict = compile(BUDGETS.replace('unpricedModel: allow-and-flag', 'unpricedModel: block'));
  expect(decide(strict, unpricedTool).preBlock).toBe('unpriced');
  // An unpriced tool type without max_uses follows failure.unpricedModel only.
  const unpricedNoMax = decide(p, features({ serverTools: [{ type: 'tool_search_tool_regex_20251119', maxUses: null }], boundKind: 'context-window', inputTokensBound: 1_000_000 }));
  expect(unpricedNoMax.preBlock).toBeNull();
  expect(unpricedNoMax.warnings).toEqual([{ kind: 'bound-assumed', reason: 'unpriced-server-tool' }]);
});

test('rewriteModel prices the reservation at the upstream model and marks the chain', () => {
  const p = compile(`${HEAD}routes:
  - { name: prod, match: { traffic: product }, chain: [a], rewriteModel: claude-haiku-5-5, reserveOutputTokens: 500 }
budgets:
  - { name: org, scope: tenant, window: day, usd: 10 }
${STORE}`);
  const f = features({ traffic: 'product', model: 'claude-opus-5-5' });
  const plan = decide(p, f);
  expect(plan.chain).toEqual([{ provider: 'a', upstreamModel: 'claude-haiku-5-5', rewritesModel: true }]);
  const haiku = reservationPrice(p.prices, 'claude-haiku-5-5').price;
  const est = worstCaseMicroUsd(f, haiku, p.prices, { serverToolsWithoutMaxUses: 'block', assumedMaxUses: 25, reserveOutputTokens: 500 }).micro;
  expect(plan.reservations[0]?.estMicroUsd).toBe(est);
});

test('GET /v1/models lists only the models the calling key routes allow', () => {
  const p = compile(`${HEAD}routes:
  - { name: product, match: { traffic: product }, chain: [a], rewriteModel: claude-haiku-5-5 }
  - { name: web, match: { team: web, surface: anthropic-messages }, chain: [a], allowModels: ["claude-sonnet-*"] }
  - { name: data, match: { team: data }, chain: [a], allowModels: ["claude-opus-5-5", "claude-haiku-*"] }
  - { name: codex, match: { surface: openai-responses }, chain: [a] }
${STORE}`);
  const key = (team: string | null, kind: KeyRecord['kind'] = 'developer'): KeyRecord => ({ hash: 'h', keyId: 'k', tenant: 'acme', team, name: 'n', kind, billing: 'api' });
  expect(modelsForKey(p, key('web'))).toEqual(['claude-sonnet-5-5']);
  expect(modelsForKey(p, key('data'))).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
  expect(modelsForKey(p, key('web', 'service'))).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  expect(modelsForKey(p, key(null))).toEqual([]);
});

test('compilePolicy refuses a policy with validation errors and deep-freezes the result', () => {
  expect(() => compile(`${HEAD}routes:\n  - { name: x, chain: [nope] }\n`)).toThrow(PolicyInvalidError);
  try {
    compile(`${HEAD}routes:\n  - { name: x, chain: [nope] }\n`);
  } catch (e) {
    expect((e as PolicyInvalidError).issues.map((i) => i.code)).toContain('E_CHAIN_UNKNOWN_PROVIDER');
  }
  const p = compile(BUDGETS);
  expect(p.priceTableVersion).toBe('2026-11-02');
  expect(p.candidate).toBeNull();
  const frozen = (v: unknown, seen = new Set<unknown>()): boolean => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return true;
    seen.add(v);
    if (!Object.isFrozen(v)) return false;
    const children = v instanceof Map ? [...v.keys(), ...v.values()] : Object.values(v);
    return children.every((c) => frozen(c, seen));
  };
  expect(frozen(p)).toBe(true);
  expect(() => (p.providers as Map<string, unknown>).set('x', {})).toThrow();
  expect(() => (p.keysByHash as Map<string, unknown>).delete('x')).toThrow();
  expect(() => (p.routes as unknown[]).push({})).toThrow();
});

test('"__proto__" and "constructor" names from policy and request reach decide as plain strings', () => {
  const yaml = `apiVersion: tokenyard/v1
kind: Policy
metadata: { name: proto }
providers:
  constructor: { format: anthropic, baseUrl: https://api.anthropic.com, credential: { env: A_KEY } }
  toString: { format: anthropic, baseUrl: https://api.anthropic.com, credential: { env: B_KEY } }
tenants:
  constructor: { teams: [__proto__] }
routes:
  - { name: __proto__, match: { team: __proto__, feature: constructor }, chain: [constructor] }
  - { name: constructor, chain: [{ provider: toString, weight: 1 }, { provider: constructor, weight: 1 }] }
budgets:
  - { name: __proto__, scope: tenant, window: day, usd: 1 }
  - { name: constructor, scope: team, window: day, usd: 2 }
rateLimits:
  - { name: __proto__, scope: key, rpm: 60 }
${STORE}`;
  const keys = `- {"hash":"${'a'.repeat(64)}","keyId":"__proto__","tenant":"constructor","team":"__proto__","name":"hasOwnProperty","kind":"developer","billing":"api"}\n`;
  const p = compilePolicy(source(yaml, keys), 'r', { experimentalSubscription: false });
  expect(p.keysByHash.get('a'.repeat(64))?.keyId).toBe('__proto__');
  expect(p.keysByHash.get('constructor')).toBeUndefined();
  expect(p.keysByHash.get('__proto__')).toBeUndefined();
  expect(p.providers.get('constructor')?.name).toBe('constructor');
  expect(p.providers.get('hasOwnProperty')).toBeUndefined();
  const f = features({ tenant: 'constructor', team: '__proto__', keyId: '__proto__', attribution: { feature: 'constructor', session: '__proto__' } });
  const plan = decide(p, f);
  expect(plan.route).toBe('__proto__');
  expect(plan.chain.map((c) => c.provider)).toEqual(['constructor']);
  expect(plan.reservations.map((r) => [r.budget, r.key])).toEqual([
    ['__proto__', 'ty:{constructor}:b:__proto__:constructor:2026-11-04'],
    ['constructor', 'ty:{constructor}:b:constructor:__proto__:2026-11-04'],
  ]);
  expect(plan.rateChecks[0]?.key).toBe('ty:{constructor}:g:__proto__:__proto__');
  const other = decide(p, features({ tenant: 'constructor', team: 'toString', attribution: { feature: '__proto__' } }));
  expect(other.route).toBe('constructor');
  expect(other.chain.map((c) => c.provider).sort()).toEqual(['constructor', 'toString']);
  expect(resolve(p, plan, admission({ kind: 'budget', name: '__proto__' })).block?.message).toContain('__proto__');
  expect(resolve(p, plan, admission({ kind: 'budget', name: 'toString' })).block?.reason).toBe('budget');
});
