// Compiles a validated policy into the immutable snapshot decide and resolve read (spec 6.7). Pure.
import type { PolicySource } from './load-dir.js';
import { globToRegExp } from './match.js';
import { chainProvider, type RouteSpec } from './schema.js';
import type { CompiledBudget, CompiledPolicy, CompiledRate, CompiledRoute, CompiledStreamLimit, KeyRecord, ProviderSpec } from './types.js';
import { validatePolicy, type Issue } from './validate.js';

/** The policy has validation errors (spec 6.4); `issues` lists them. A load keeps the old snapshot. */
export class PolicyInvalidError extends Error {
  constructor(readonly issues: Issue[]) {
    const first = issues[0];
    super(`policy is invalid: ${first ? `${first.code} ${first.path}: ${first.message}` : 'unknown error'}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`);
    this.name = 'PolicyInvalidError';
  }
}

const refuse = (): never => {
  throw new TypeError('compiled policy is immutable');
};

/** A Map whose mutators throw, frozen with every key and value. */
function frozenMap<K, V>(entries: Iterable<[K, V]>): ReadonlyMap<K, V> {
  const m = new Map(entries);
  for (const [k, v] of m) {
    deepFreeze(k);
    deepFreeze(v);
  }
  Object.defineProperties(m, { set: { value: refuse }, delete: { value: refuse }, clear: { value: refuse } });
  return Object.freeze(m);
}

function deepFreeze<T>(v: T): T {
  if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return v;
  if (v instanceof Map) throw new TypeError('use frozenMap for maps in a compiled policy');
  Object.freeze(v);
  if (!(v instanceof RegExp)) for (const child of Object.values(v)) deepFreeze(child);
  return v;
}

function listedModels(r: RouteSpec, priced: readonly string[]): string[] {
  if (r.allowModels !== undefined) {
    const res = r.allowModels.map(globToRegExp);
    return priced.filter((id) => res.some((re) => re.test(id)));
  }
  if (r.rewriteModel !== undefined) return [r.rewriteModel];
  return [...priced];
}

function compileRoute(r: RouteSpec, priced: readonly string[]): CompiledRoute {
  const m = r.match;
  return {
    name: r.name,
    match: {
      surface: m.surface ?? null,
      traffic: m.traffic ?? null,
      billing: m.billing ?? null,
      tenant: m.tenant ?? null,
      team: m.team ?? null,
      requestClass: m.requestClass ?? null,
      agentType: m.agentType ?? null,
      repo: m.repo ?? null,
      feature: m.feature ?? null,
      model: m.model === undefined ? null : globToRegExp(m.model),
    },
    chain: r.chain.map((e) => ({ provider: chainProvider(e), weight: typeof e === 'string' ? null : e.weight })),
    allowModels: r.allowModels?.map(globToRegExp) ?? null,
    rewriteModel: r.rewriteModel ?? null,
    allowBodyRewrite: r.allowBodyRewrite === true,
    fallbackOn429: r.fallbackOn429 === true,
    serverTools: r.serverTools ?? null,
    criticality: r.criticality ?? 'standard',
    reserveOutputTokens: r.reserveOutputTokens ?? null,
    listedModels: listedModels(r, priced),
  };
}

/**
 * Validates `src` and compiles it: globs to anchored RegExps, budgets to micro-USD, rate limits to GCRA emission
 * intervals, providers and keys to Maps (never plain-object lookups: names come from policy text). The result is
 * deep-frozen, so a request that started under it sees the same snapshot to its end.
 */
export function compilePolicy(src: PolicySource, revision: string, o: { experimentalSubscription: boolean }): CompiledPolicy {
  const { errors } = validatePolicy(src, o);
  if (errors.length > 0) throw new PolicyInvalidError(errors);
  const { policy, prices, keys } = src;
  const priced = Object.keys(prices.models);

  const providers = Object.entries(policy.providers).map(([name, p]): [string, ProviderSpec] => [
    name,
    { name, format: p.format, baseUrl: p.baseUrl, credential: p.credential === 'passthrough' ? 'passthrough' : { env: p.credential.env } },
  ]);
  const budgets = policy.budgets.map((b): CompiledBudget => ({
    name: b.name,
    scope: b.scope,
    window: b.scope === 'session' ? null : (b.window as 'day' | 'week' | 'month'),
    limitMicroUsd: Math.round(b.usd * 1_000_000),
    enforce: b.mode === 'enforce' && (b.onExceed ?? 'block') === 'block',
    // Spec 7.6: subscription-billed traffic is priced as API-equivalent cost, so its budgets default to onExceed: warn.
    enforceSubscription: b.mode === 'enforce' && b.onExceed === 'block',
  }));
  const rateLimits: CompiledRate[] = [];
  const streamLimits: CompiledStreamLimit[] = [];
  for (const r of policy.rateLimits) {
    if (r.rpm !== undefined) rateLimits.push({ name: r.name, scope: r.scope, emissionMs: Math.ceil(60_000 / r.rpm), burst: r.burst ?? 1 });
    if (r.concurrentStreams !== undefined) streamLimits.push({ name: r.name, scope: r.scope, max: r.concurrentStreams });
  }

  const compiled: CompiledPolicy = {
    revision,
    priceTableVersion: prices.version,
    providers: frozenMap(providers),
    keysByHash: frozenMap(keys.map((k): [string, KeyRecord] => [k.hash, { ...k }])),
    routes: policy.routes.map((r) => compileRoute(r, priced)),
    budgets,
    rateLimits,
    streamLimits,
    reservation: structuredClone(policy.reservation),
    sessions: structuredClone(policy.sessions),
    guardrails: structuredClone(policy.guardrails),
    failure: structuredClone(policy.failure),
    ci: structuredClone(policy.ci),
    prices: structuredClone(prices),
    candidate: null,
  };
  return deepFreeze(compiled);
}

/** The active policy with a candidate attached for audit mode (spec 6.5): both are decided, the active one is enforced. */
export function attachCandidate(active: CompiledPolicy, candidate: CompiledPolicy | null): CompiledPolicy {
  return Object.freeze({ ...active, candidate: candidate === null ? null : Object.freeze({ ...candidate, candidate: null }) });
}
