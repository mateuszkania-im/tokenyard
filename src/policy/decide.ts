// Spec 6.5: the pure decision function. No I/O, no clock (window starts come from `f.ts`), no randomness
// (weighted splits hash the session or request id). Same arguments, same plan: replay over traces relies on it.
import { createHash } from 'node:crypto';
import { inputTokenBound, reservationPrice, serverToolKey, sessionAwareMicroUsd, worstCaseMicroUsd } from '../limits/estimator.js';
import { budgetKey, gcraKey, streamKey, taintKey } from '../limits/keys.js';
import { lookupModel, type ModelPrice, type PriceTable } from '../pricing/prices.js';
import type { ExtractedFeatures } from '../surfaces/types.js';
import { findAuthzRoute, findRoute, globTest } from './match.js';
import { REQUEST_CLASSES } from './schema.js';
import type { CompiledBudget, CompiledPolicy, CompiledRoute, GuardrailHit, KeyRecord, Plan, RawAttribution, RequestFeatures, Surface, Warning } from './types.js';

const DAY_MS = 86_400_000;
/** Scope value for an enforced level whose header-derived value (session, repo) is missing, so omitting it dodges nothing. */
export const UNATTRIBUTED = '(unattributed)';
const CLASSES: ReadonlySet<string> = new Set(REQUEST_CLASSES);

const hasModels = (t: PriceTable): boolean => Object.keys(t.models).length > 0;
/** The model name when the table prices it, else null: unknown and missing models are priced as the table's envelope. */
const pricedName = (t: PriceTable, model: string): string | null => (model !== '' && lookupModel(t, model) !== null ? model : null);

/**
 * Request features for `decide` (spec 5.3 step 4 to 6). The input bound uses the requested model's limits, or for an
 * unknown, missing or unparseable model `reservationPrice(prices, null)` (every model's largest window), never a guess.
 * `attr` should already hold pseudonyms for session and agent ids when traces are written, so replay sees the same values.
 */
export function buildFeatures(
  x: ExtractedFeatures,
  key: KeyRecord,
  attr: RawAttribution,
  hits: GuardrailHit[],
  prices: PriceTable,
  id: string,
  ts: number,
  surface: Surface,
): RequestFeatures {
  const model = x.parseError ? '' : (x.model ?? '');
  // An empty table (serve --dev-upstream) knows no context window: the bound is unknown, so it is as large as can be.
  const bound = hasModels(prices) ? inputTokenBound(x, reservationPrice(prices, pricedName(prices, model)).price) : { tokens: Number.MAX_SAFE_INTEGER, kind: 'context-window' as const };
  return {
    id,
    ts,
    surface,
    traffic: key.kind === 'service' ? 'product' : 'coding-agent',
    billing: key.billing,
    tenant: key.tenant,
    team: key.team,
    keyId: key.keyId,
    model,
    stream: x.stream,
    inputTokensBound: bound.tokens,
    boundKind: bound.kind,
    maxOutputTokens: x.maxOutputTokens,
    serverTools: x.serverTools.map((t) => ({ ...t })),
    toolCount: x.toolCount,
    thinking: x.thinking,
    fastMode: x.fastMode,
    attribution: {
      session: attr.session,
      agent: attr.agent,
      parentAgent: attr.parentAgent,
      requestClass: attr.requestClass !== null && CLASSES.has(attr.requestClass) ? (attr.requestClass as RequestFeatures['attribution']['requestClass']) : null,
      agentType: attr.agentType,
      promptId: attr.promptId,
      repo: attr.repo,
      branch: attr.branch,
      ticket: attr.ticket,
      feature: attr.feature,
    },
    guardrail: { hits: hits.map((h) => ({ ...h })) },
  };
}

/** UTC window containing `ts`: day, ISO week (Monday start) or calendar month. */
function windowOf(window: 'day' | 'week' | 'month', ts: number): { start: string; end: string } {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  let start: number;
  let end: number;
  if (window === 'day') {
    start = Date.UTC(y, m, day);
    end = start + DAY_MS;
  } else if (window === 'week') {
    start = Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7));
    end = start + 7 * DAY_MS;
  } else {
    start = Date.UTC(y, m, 1);
    end = Date.UTC(y, m + 1, 1);
  }
  return { start: new Date(start).toISOString().slice(0, 10), end: new Date(end).toISOString() };
}

function scopeValue(scope: CompiledBudget['scope'], f: RequestFeatures): string | null {
  switch (scope) {
    case 'tenant':
      return f.tenant;
    case 'team':
      return f.team;
    case 'key':
      return f.keyId;
    case 'repo':
      return f.attribution.repo;
    case 'session':
      return f.attribution.session;
  }
}

/**
 * Provider order for this request. A weighted split puts one weighted entry first, chosen by a hash of the route
 * name and `seed` (session id, else request id), so a session keeps its provider and its prompt cache; every other
 * entry follows in policy order as a fallback. Entries with weight 0 are only ever fallbacks.
 */
function orderChain(route: CompiledRoute, seed: string): string[] {
  const names = route.chain.map((e) => e.provider);
  const total = route.chain.reduce((s, e) => s + (e.weight ?? 0), 0);
  if (total <= 0) return names;
  const h = createHash('sha256').update(route.name).update('\0').update(seed).digest().readUInt32BE(0);
  const x = (h / 2 ** 32) * total;
  let acc = 0;
  let pick = route.chain.findIndex((e) => {
    acc += e.weight ?? 0;
    return (e.weight ?? 0) > 0 && x < acc;
  });
  // Float rounding can leave x at the very top of the range: the last weighted entry takes it.
  for (let i = route.chain.length - 1; pick < 0 && i >= 0; i--) if ((route.chain[i]?.weight ?? 0) > 0) pick = i;
  return [names[pick] as string, ...names.filter((_, i) => i !== pick)];
}

/**
 * Features as seen by the upstream model. A rewrite to another model keeps a bytes bound that is below the requested
 * model's window (the body bytes themselves), capped at the new window; any other bound becomes the new window.
 */
function upstreamFeatures(f: RequestFeatures, t: PriceTable, upstreamModel: string, up: ModelPrice): RequestFeatures {
  if (upstreamModel === f.model) return f;
  const requested = reservationPrice(t, pricedName(t, f.model)).price;
  if (f.boundKind === 'bytes' && f.inputTokensBound < requested.maxContextTokens) {
    return { ...f, model: upstreamModel, inputTokensBound: Math.min(f.inputTokensBound, up.maxContextTokens) };
  }
  return { ...f, model: upstreamModel, inputTokensBound: up.maxContextTokens, boundKind: 'context-window' };
}

export function decide(policy: CompiledPolicy, f: RequestFeatures): Plan {
  const hits = f.guardrail.hits;
  const warnings: Warning[] = hits.filter((h) => h.action === 'warn').map((h) => ({ kind: 'guardrail', rule: h.rule, where: h.where }));
  const lastTurnBlocks = hits.filter((h) => h.action === 'block' && h.where === 'last-turn');
  const session = f.attribution.session;
  const taint: Plan['taint'] =
    session === null && !hits.some((h) => h.action === 'block')
      ? null
      : {
          key: taintKey(f.tenant, session ?? f.keyId),
          check: [...new Set(hits.filter((h) => h.where === 'history').map((h) => h.valueHmac))],
          add: lastTurnBlocks.map((h) => ({ rule: h.rule, valueHmac: h.valueHmac })),
          ttlMs: Math.round(policy.guardrails.secrets.taintTtlHours * 3_600_000),
        };
  const plan: Plan = { policyRevision: policy.revision, route: null, chain: [], reservations: [], rateChecks: [], streamSlots: [], taint, preBlock: null, warnings };

  const route = findRoute(policy, f);
  if (!route) return { ...plan, preBlock: 'no-route' };
  plan.route = route.name;
  // Client headers may pick the route, not widen the models: the header-free route must allow the model too (spec 11).
  const authz = route.match.requestClass === null && route.match.agentType === null && route.match.repo === null && route.match.feature === null ? route : findAuthzRoute(policy, f);
  if (authz === null) return { ...plan, preBlock: 'no-route' };
  const allows = (r: CompiledRoute): boolean => r.allowModels === null || r.allowModels.some((re) => globTest(re, f.model));
  if (!allows(route) || !allows(authz)) return { ...plan, preBlock: 'model-not-allowed' };
  // Server tools are denied unless the route lists their type (date suffix dropped).
  const refused = f.serverTools.filter((tool) => !(route.serverTools ?? []).includes(serverToolKey(tool.type)));
  if (refused.length > 0) {
    return { ...plan, preBlock: 'server-tool-not-allowed', warnings: [...warnings, ...refused.map((tool): Warning => ({ kind: 'server-tool-not-allowed', type: tool.type }))] };
  }

  // A rewrite changes body bytes: product traffic, or coding-agent traffic behind allowBodyRewrite (spec 6.4).
  const mayRewrite = route.rewriteModel !== null && (f.traffic === 'product' || route.allowBodyRewrite);
  const upstreamModel = mayRewrite ? (route.rewriteModel as string) : f.model;
  const rewritesModel = upstreamModel !== f.model;
  plan.chain = orderChain(route, session ?? f.id).map((provider) => ({ provider, upstreamModel, rewritesModel }));
  if (lastTurnBlocks.length > 0) return { ...plan, preBlock: 'secret' };
  // count_tokens is free: forwarded with no reservation, rate check or stream slot (spec 5.3).
  if (f.surface === 'anthropic-count-tokens') return plan;

  const t = policy.prices;
  const known = pricedName(t, upstreamModel);
  if (known === null) {
    if (policy.failure.unpricedModel !== 'allow-and-flag') return { ...plan, preBlock: 'unpriced' };
    warnings.push({ kind: 'unpriced', model: upstreamModel });
  }

  const levels = policy.budgets.flatMap((b) => {
    // A key without a team skips team levels; a missing session or repo header is charged to UNATTRIBUTED on enforced
    // levels, so leaving a header out cannot dodge a budget.
    const headerScoped = b.scope === 'session' || b.scope === 'repo';
    const value = scopeValue(b.scope, f) ?? (headerScoped && b.enforce ? UNATTRIBUTED : null);
    if (value === null) return [];
    const w = b.window === null ? null : windowOf(b.window, f.ts);
    return [{ budget: b.name, key: budgetKey(f.tenant, b.name, value, w?.start ?? null), limitMicroUsd: b.limitMicroUsd, enforce: b.enforce, resetsAt: w?.end ?? null }];
  });

  let est = 0;
  if (hasModels(t)) {
    const price = reservationPrice(t, known).price;
    const uf = upstreamFeatures(f, t, upstreamModel, price);
    const r = policy.reservation;
    const worst = worstCaseMicroUsd(uf, price, t, { serverToolsWithoutMaxUses: r.serverToolsWithoutMaxUses, assumedMaxUses: r.assumedMaxUses, reserveOutputTokens: route.reserveOutputTokens });
    est = r.estimator === 'session-aware' ? sessionAwareMicroUsd(uf, price, t, null, route.reserveOutputTokens) : worst.micro;
    if (worst.block === 'unpriced-server-tool') {
      if (policy.failure.unpricedModel !== 'allow-and-flag') return { ...plan, preBlock: 'unpriced' };
      warnings.push({ kind: 'bound-assumed', reason: 'unpriced-server-tool' });
    }
    // Spec 7.3: a priced server tool without max_uses has no fee bound; refuse it when the request would touch an
    // enforced budget. An unpriced tool type follows failure.unpricedModel alone (handled above).
    if (f.serverTools.some((tool) => tool.maxUses === null && Object.hasOwn(t.serverTools, serverToolKey(tool.type)))) {
      if (r.serverToolsWithoutMaxUses === 'block' && levels.some((l) => l.enforce)) return { ...plan, preBlock: 'server-tool-no-max-uses' };
      warnings.push({ kind: 'bound-assumed', reason: 'server-tool-no-max-uses' });
    }
  } else if (levels.length > 0) {
    throw new Error('the price table has no models, so no reservation can be priced');
  }

  plan.reservations = levels.map((l) => ({ ...l, estMicroUsd: est }));
  plan.rateChecks = policy.rateLimits.flatMap((l) => {
    const value = scopeValue(l.scope, f);
    return value === null ? [] : [{ limit: l.name, key: gcraKey(f.tenant, l.name, value), emissionMs: l.emissionMs, burst: l.burst, quantity: 1 }];
  });
  // Slots deliberately apply to every messages request, streamed or not: both hold an upstream slot (spec 5.3, 11).
  plan.streamSlots = policy.streamLimits.flatMap((l) => {
    const value = scopeValue(l.scope, f);
    return value === null ? [] : [{ limit: l.name, key: streamKey(f.tenant, l.name, value), max: l.max }];
  });
  return plan;
}
