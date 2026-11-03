// Spec 6.5: the pure decision function. No I/O, no clock (window starts come from `f.ts`), no randomness
// (weighted splits hash the session or request id). Same arguments, same plan: replay over traces relies on it.
import { createHash } from 'node:crypto';
import { inputTokenBound, reservationPrice, serverToolKey, sessionAwareMicroUsd, worstCaseMicroUsd } from '../limits/estimator.js';
import { budgetKey, gcraKey, keyTaintKey, newSessionsKey, sessionKey, streamKey, taintKey } from '../limits/keys.js';
import { lookupModel, type ModelPrice, type PriceTable, serverToolFormat, serverToolPrice, serviceTierPrice } from '../pricing/prices.js';
import type { ExtractedFeatures } from '../surfaces/types.js';
import { findAuthzRoute, findRoute, modelMatches } from './match.js';
import { REQUEST_CLASSES } from './schema.js';
import type { CompiledBudget, CompiledPolicy, CompiledRoute, GuardrailHit, KeyRecord, Plan, RawAttribution, RequestFeatures, Surface, Warning } from './types.js';

const DAY_MS = 86_400_000;
/** Scope value for an enforced level whose header-derived value (session, repo) is missing, so omitting it dodges nothing. */
export const UNATTRIBUTED = '(unattributed)';
const CLASSES: ReadonlySet<string> = new Set(REQUEST_CLASSES);

const hasModels = (t: PriceTable): boolean => Object.keys(t.models).length > 0;
/** The model name when the table prices it, else null: unknown and missing models are priced as the table's envelope. */
const pricedName = (t: PriceTable, model: string): string | null => (model !== '' && lookupModel(t, model) !== null ? model : null);

export interface BuildFeaturesOptions {
  /**
   * R11: a settled request billed more input than its bytes bound, so the tokenizer assumption failed; every request
   * uses the context-window bound until restart.
   */
  bytesBoundOff?: boolean;
}

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
  o: BuildFeaturesOptions = {},
): RequestFeatures {
  const model = x.parseError ? '' : (x.model ?? '');
  // An empty table (serve --dev-upstream) knows no context window: the bound is unknown, so it is as large as can be.
  let bound = hasModels(prices) ? inputTokenBound(x, reservationPrice(prices, pricedName(prices, model)).price) : { tokens: Number.MAX_SAFE_INTEGER, kind: 'context-window' as const };
  if (o.bytesBoundOff && bound.kind === 'bytes') bound = { tokens: reservationPrice(prices, pricedName(prices, model)).price.maxContextTokens, kind: 'context-window' };
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
    ...(x.compaction ? { compaction: true } : {}),
    ...(x.serviceTier !== undefined ? { serviceTier: x.serviceTier } : {}),
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

/** UTC window containing `ts`: day, ISO week (Monday start) or calendar month. `end` is the next window's start, ISO. */
export function windowOf(window: 'day' | 'week' | 'month', ts: number): { start: string; end: string } {
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

/** The parts of a request (or of a trace record, for warm-up) a level's scope reads. */
export interface ScopeSource {
  tenant: string;
  team: string | null;
  keyId: string;
  attribution: { repo: string | null; session: string | null };
}

function scopeValue(scope: CompiledBudget['scope'], f: ScopeSource): string | null {
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
 * Scope value of one budget, rate or stream level, or null to skip it. Key-derived values (a key without a team) skip;
 * a missing client header (session, repo) on an enforced level is charged to UNATTRIBUTED, so leaving it out dodges
 * nothing. Rate and stream levels always enforce.
 */
export function levelValue(scope: CompiledBudget['scope'], f: ScopeSource, enforce: boolean): string | null {
  const value = scopeValue(scope, f);
  if (value !== null) return value;
  return (scope === 'session' || scope === 'repo') && enforce ? UNATTRIBUTED : null;
}

/** Whether a budget blocks this request: for subscription billing an unstated onExceed means warn (spec 7.6). */
export function budgetEnforced(b: CompiledBudget, billing: RequestFeatures['billing']): boolean {
  return billing === 'subscription' ? b.enforceSubscription : b.enforce;
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

/** The budget levels a request touches, with their keys for its window. */
function budgetLevels(policy: CompiledPolicy, f: RequestFeatures): Array<Omit<Plan['reservations'][number], 'estMicroUsd'>> {
  return policy.budgets.flatMap((b) => {
    // A key without a team skips team levels; a missing session or repo header is charged to UNATTRIBUTED on enforced
    // levels, so leaving a header out cannot dodge a budget.
    const enforce = budgetEnforced(b, f.billing);
    const value = levelValue(b.scope, f, enforce);
    if (value === null) return [];
    const w = b.window === null ? null : windowOf(b.window, f.ts);
    return [{ budget: b.name, key: budgetKey(f.tenant, b.name, value, w?.start ?? null), limitMicroUsd: b.limitMicroUsd, enforce, resetsAt: w?.end ?? null }];
  });
}

/** Whether an enforced budget level applies to this request (whatever its route or model). */
export function enforcedLevelApplies(policy: CompiledPolicy, f: RequestFeatures): boolean {
  return budgetLevels(policy, f).some((l) => l.enforce);
}

export function decide(policy: CompiledPolicy, f: RequestFeatures): Plan {
  const hits = f.guardrail.hits;
  const warnings: Warning[] = hits.filter((h) => h.action === 'warn').map((h) => ({ kind: 'guardrail', rule: h.rule, where: h.where }));
  const lastTurnBlocks = hits.filter((h) => h.action === 'block' && h.where === 'last-turn');
  const session = f.attribution.session;
  // Hits without a value HMAC (PII, B8) never taint: there is no value to remember or look up.
  const history = hits.filter((h) => h.where === 'history' && h.valueHmac !== '');
  const messages: Record<string, number> = {};
  for (const h of history) if (h.message !== undefined && !Object.hasOwn(messages, h.valueHmac)) messages[h.valueHmac] = h.message;
  const taint: Plan['taint'] =
    session === null && !hits.some((h) => h.action === 'block')
      ? null
      : {
          key: session === null ? keyTaintKey(f.tenant, f.keyId) : taintKey(f.tenant, session),
          check: [...new Set(history.map((h) => h.valueHmac))],
          add: lastTurnBlocks.filter((h) => h.valueHmac !== '').map((h) => ({ rule: h.rule, valueHmac: h.valueHmac, ...(h.message === undefined ? {} : { message: h.message }) })),
          ttlMs: Math.round(policy.guardrails.secrets.taintTtlHours * 3_600_000),
          ...(Object.keys(messages).length > 0 ? { messages } : {}),
        };
  const plan: Plan = { id: f.id, policyRevision: policy.revision, route: null, chain: [], reservations: [], rateChecks: [], streamSlots: [], taint, preBlock: null, warnings };
  // S-V2-1: a session counts against its key's allowance of new sessions until the store has seen it, for any request
  // that reaches the store (a last-turn secret writes a taint set for the session, so it counts too).
  const idleTtlMs = policy.sessions.idleTtlHours * 3_600_000;
  if (session !== null) {
    // A key's own limit, else the default for its kind (service keys carry product traffic).
    const own = policy.newSessionLimits.get(f.keyId);
    const service = f.traffic === 'product';
    const perHour = own ?? (service ? policy.sessions.newPerServiceKeyPerHour : policy.sessions.newPerKeyPerHour);
    const limit = own !== undefined ? 'maxNewSessionsPerHour in keys.yaml' : service ? 'sessions.newPerServiceKeyPerHour' : 'sessions.newPerKeyPerHour';
    plan.newSession = { limit, markerKey: sessionKey(f.tenant, session), key: newSessionsKey(f.tenant, f.keyId), emissionMs: Math.ceil(3_600_000 / perHour), burst: perHour, ttlMs: idleTtlMs };
  }

  const route = findRoute(policy, f);
  if (!route) return { ...plan, preBlock: 'no-route' };
  plan.route = route.name;
  // Client headers may pick the route, not widen the models: the header-free route must allow the model too (spec 11).
  const authz = route.match.requestClass === null && route.match.agentType === null && route.match.repo === null && route.match.feature === null ? route : findAuthzRoute(policy, f);
  if (authz === null) return { ...plan, preBlock: 'no-route' };
  const allows = (r: CompiledRoute, model: string): boolean => r.allowModels === null || r.allowModels.some((re) => modelMatches(re, f, model));
  if (!allows(route, f.model) || !allows(authz, f.model)) return { ...plan, preBlock: 'model-not-allowed' };
  // Server tools are denied unless both routes list their type (date suffix dropped): a header cannot unlock a tool.
  const lists = (r: CompiledRoute, type: string): boolean => (r.serverTools ?? []).includes(serverToolKey(type));
  const refused = f.serverTools.filter((tool) => !lists(route, tool.type) || !lists(authz, tool.type));
  if (refused.length > 0) {
    return { ...plan, preBlock: 'server-tool-not-allowed', warnings: [...warnings, ...refused.map((tool): Warning => ({ kind: 'server-tool-not-allowed', type: tool.type }))] };
  }

  // A rewrite changes body bytes: product traffic, or coding-agent traffic behind allowBodyRewrite (spec 6.4).
  const bodyRewritable = f.traffic === 'product' || route.allowBodyRewrite;
  const mayRewrite = route.rewriteModel !== null && bodyRewritable;
  const upstreamModel = mayRewrite ? (route.rewriteModel as string) : f.model;
  const rewritesModel = upstreamModel !== f.model;
  // The served model must be one both routes allow, so a header-chosen rewrite cannot reach a model the key may not use.
  if (rewritesModel && (!allows(route, upstreamModel) || !allows(authz, upstreamModel))) return { ...plan, preBlock: 'model-not-allowed' };
  plan.chain = orderChain(route, session ?? f.id).map((provider) => ({ provider, upstreamModel, rewritesModel }));
  if (lastTurnBlocks.length > 0) return { ...plan, preBlock: 'secret' };
  // count_tokens is free: forwarded with no reservation, rate check or stream slot (spec 5.3).
  if (f.surface === 'anthropic-count-tokens') return plan;

  const t = policy.prices;
  const known = pricedName(t, upstreamModel);
  // An OpenAI service tier is priced only from the model's own tier prices: a named tier without them (priority, flex,
  // an unknown value) is never priced as standard (ruling S20-1). `auto` reserves at the highest listed tier.
  const tier = f.serviceTier;
  if (tier !== undefined && tier !== 'auto') {
    const m = known === null ? null : lookupModel(t, known)?.price;
    // `other` stands for any tier outside the known ones (B1) and is never priced, whatever the table lists.
    if (!m || tier === 'other' || serviceTierPrice(m, tier) === null) return { ...plan, preBlock: 'unpriced' };
  }
  // Fast mode is priced only from the model's own fast prices: a request asking it on a priced model without them is
  // refused as a tier without tier prices is (ruling superseding CL-t9e), never reserved at the standard rates. An
  // unpriced model takes the unpriced-model path below.
  if (f.fastMode && known !== null && lookupModel(t, known)?.price.fast === undefined) return { ...plan, preBlock: 'unpriced' };
  const levels = budgetLevels(policy, f);

  // An unpriced model is reserved at the envelope of the priced ones, which is no bound for a model dearer than all of
  // them: refused whenever an enforced level applies, as an unpriced server tool is (A2); allow-and-flag admits it only
  // when none does.
  if (known === null) {
    if (policy.failure.unpricedModel !== 'allow-and-flag' || (hasModels(t) && levels.some((l) => l.enforce))) return { ...plan, preBlock: 'unpriced' };
    warnings.push({ kind: 'unpriced', model: upstreamModel });
  }

  // reserveOutputTokens lowers the reservation only when the gateway writes it into the body as max_tokens
  // (max_output_tokens), under the same rule as a model rewrite; otherwise the client's own limit stands (A1).
  const reserve = route.reserveOutputTokens !== null && bodyRewritable && (f.surface === 'anthropic-messages' || f.surface === 'openai-responses') ? route.reserveOutputTokens : null;
  // Always checked in the body, even when the parsed limit is already below it: a duplicate key may read differently
  // upstream (S25-1).
  if (reserve !== null) plan.outputCap = reserve;

  let est = 0;
  let worstMicro: number | undefined;
  if (hasModels(t)) {
    const price = reservationPrice(t, known).price;
    const uf = upstreamFeatures(f, t, upstreamModel, price);
    const r = policy.reservation;
    const worst = worstCaseMicroUsd(uf, price, t, { serverToolsWithoutMaxUses: r.serverToolsWithoutMaxUses, assumedMaxUses: r.assumedMaxUses, reserveOutputTokens: reserve });
    est = r.estimator === 'session-aware' ? sessionAwareMicroUsd(uf, price, t, null, reserve) : worst.micro;
    worstMicro = worst.micro;
    const enforced = levels.some((l) => l.enforce);
    // An unpriced server tool has no bound at all (its loop is reserved as one iteration): refused whenever an
    // enforced level applies; failure.unpricedModel: allow-and-flag admits it only when none does.
    if (worst.block === 'unpriced-server-tool') {
      if (enforced || policy.failure.unpricedModel !== 'allow-and-flag') return { ...plan, preBlock: 'unpriced' };
      warnings.push({ kind: 'bound-assumed', reason: 'unpriced-server-tool' });
    }
    // Spec 7.3: a priced server tool with a per-use fee and no max_uses has no fee bound; refuse it when the request
    // would touch an enforced budget. A tool without a fee (tool search) is bounded by its loop alone.
    const feeWithoutMaxUses = f.serverTools.some((tool) => tool.maxUses === null && (serverToolPrice(t, serverToolFormat(f.surface), serverToolKey(tool.type))?.perUseUsd ?? 0) > 0);
    if (feeWithoutMaxUses) {
      if (r.serverToolsWithoutMaxUses === 'block' && enforced) return { ...plan, preBlock: 'server-tool-no-max-uses' };
      warnings.push({ kind: 'bound-assumed', reason: 'server-tool-no-max-uses' });
    }
  } else if (levels.length > 0) {
    throw new Error('the price table has no models, so no reservation can be priced');
  }

  plan.reservations = levels.map((l) => ({ ...l, estMicroUsd: est }));
  if (levels.some((l) => l.resetsAt === null)) plan.sessionIdleTtlMs = idleTtlMs;
  // A request that ends without final usage settles at no less than this (A2-2): under session-aware the reservation
  // prices one iteration and no server tool fees, so it is no charge for a loop the provider may have run and billed.
  if (worstMicro !== undefined && levels.length > 0) plan.worstCaseMicroUsd = worstMicro;
  plan.rateChecks = policy.rateLimits.flatMap((l) => {
    const value = levelValue(l.scope, f, true);
    return value === null ? [] : [{ limit: l.name, key: gcraKey(f.tenant, l.name, value), emissionMs: l.emissionMs, burst: l.burst, quantity: 1 }];
  });
  // Slots deliberately apply to every messages request, streamed or not: both hold an upstream slot (spec 5.3, 11).
  plan.streamSlots = policy.streamLimits.flatMap((l) => {
    const value = levelValue(l.scope, f, true);
    return value === null ? [] : [{ limit: l.name, key: streamKey(f.tenant, l.name, value), max: l.max }];
  });
  return plan;
}
