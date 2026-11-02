// Route matching (spec 6.5: first match wins). Pure.
import type { CompiledPolicy, CompiledRoute, KeyRecord, RequestFeatures, Surface } from './types.js';

/**
 * Longest string a glob is tried against. Model ids are short; a longer value (a body field the client chose)
 * matches no pattern, which also keeps the regex work per request small whatever the pattern.
 */
export const MAX_GLOB_INPUT = 256;

/** `*` matches any run of characters; everything else is literal. Anchored at both ends; runs of `*` collapse to one. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/\*+/g, '*')
    .split('*')
    .map((lit) => lit.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 's');
}

export function globTest(re: RegExp, value: string): boolean {
  return value.length <= MAX_GLOB_INPUT && re.test(value);
}

const eq = <T>(want: T | null, have: T | null): boolean => want === null || want === have;

/** Every condition the route states holds for the request, the surface taken as `surface`. */
export function routeMatches(r: CompiledRoute, f: RequestFeatures, surface: Surface): boolean {
  const m = r.match;
  const a = f.attribution;
  return (
    eq(m.surface, surface) &&
    eq(m.traffic, f.traffic) &&
    eq(m.billing, f.billing) &&
    eq(m.tenant, f.tenant) &&
    eq(m.team, f.team) &&
    eq(m.requestClass, a.requestClass) &&
    eq(m.agentType, a.agentType) &&
    eq(m.repo, a.repo) &&
    eq(m.feature, a.feature) &&
    (m.model === null || globTest(m.model, f.model))
  );
}

/**
 * First matching route. `count_tokens` takes the route of the messages request it counts for (same models and
 * providers, no reservation) unless a route names `anthropic-count-tokens` itself.
 */
export function findRoute(policy: CompiledPolicy, f: RequestFeatures): CompiledRoute | null {
  const direct = policy.routes.find((r) => routeMatches(r, f, f.surface));
  if (direct) return direct;
  if (f.surface === 'anthropic-count-tokens') return policy.routes.find((r) => routeMatches(r, f, 'anthropic-messages')) ?? null;
  return null;
}

/**
 * Model ids `GET /v1/models` lists for a key (spec 5.3): the routes a messages request with this key could take,
 * judged on what the key decides (traffic, billing, tenant, team, surface); conditions that depend on the request
 * (request class, agent type, repo, feature, model) are assumed to hold. In route order, without duplicates.
 */
export function modelsForKey(policy: CompiledPolicy, key: KeyRecord): string[] {
  const traffic = key.kind === 'service' ? 'product' : 'coding-agent';
  const out = new Set<string>();
  for (const r of policy.routes) {
    const m = r.match;
    const reachable =
      (m.surface === null || m.surface === 'anthropic-messages') &&
      eq(m.traffic, traffic) &&
      eq(m.billing, key.billing) &&
      eq(m.tenant, key.tenant) &&
      (m.team === null || m.team === key.team);
    if (reachable) for (const id of r.listedModels) out.add(id);
  }
  return [...out];
}
