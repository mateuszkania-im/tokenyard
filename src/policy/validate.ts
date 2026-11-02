// Semantic validation of a loaded policy (spec 6.4). Pure: reads no environment, so whether a credential env var is set stays a runtime concern.
import { lookupModel } from '../pricing/prices.js';
import type { PolicySource } from './load-dir.js';
import type { ProviderSpec } from './types.js';
import { chainProvider, SURFACE_LIST, type RouteSpec } from './schema.js';

export interface Issue {
  code: string;
  path: string;
  message: string;
}

export const ERROR_CODES = [
  'E_CHAIN_UNKNOWN_PROVIDER',
  'E_CHAIN_LENGTH',
  'E_CODING_AGENT_FORMAT',
  'E_CODING_AGENT_NON_CLAUDE',
  'E_BODY_REWRITE',
  'E_PASSTHROUGH_HOST',
  'E_SUBSCRIPTION_FLAG',
  'E_UNPRICED_MODEL',
  'E_MODEL_LIMITS',
  'E_UNPRICED_SERVER_TOOL',
  'E_BUDGET_DUP',
  'E_BUDGET_WINDOW',
  'E_BUDGET_USD',
  'E_STORE_DOWN_UNSTATED',
  'E_CREDENTIAL_ENV',
  'E_REWRITE_NOT_AUTHORIZED',
] as const;

export const WARNING_CODES = ['W_CHILD_BUDGET', 'W_SURFACE_NO_ROUTE', 'W_ROUTE_SHADOWED', 'W_SESSION_AWARE_BLOCK', 'W_SERVER_TOOLS_ASSUME', 'W_SUBSCRIPTION_BLOCK', 'W_HEADER_ROUTE_GRANTS', 'W_UNPRICED_TOOL_ENFORCED'] as const;

/** Codes `loadPolicyDir` throws with (PolicyLoadError.code) before validation can run. */
export const LOAD_ERROR_CODES = ['E_FILE_MISSING', 'E_YAML_UNSAFE', 'E_YAML_SYNTAX', 'E_SCHEMA', 'E_PRICES_INVALID', 'E_MODEL_LIMITS_MISSING'] as const;

const OFFICIAL_HOST: Record<ProviderSpec['format'], string> = { anthropic: 'api.anthropic.com', openai: 'api.openai.com' };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOW_RANK: Record<string, number> = { day: 1, week: 2, month: 3 };
const SCOPE_RANK: Record<string, number> = { tenant: 3, team: 2, key: 1, repo: 0, session: 0 };

/** `*` matches any run of characters; everything else is literal. Linear scan with one backtrack point, so no pattern can blow up. */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

const MATCH_FIELDS = ['surface', 'traffic', 'billing', 'tenant', 'team', 'requestClass', 'agentType', 'repo', 'feature', 'model'] as const;
/** Match fields whose value comes from client headers (decide.ts authorises the model on the route found without them). */
const HEADER_FIELDS = ['requestClass', 'agentType', 'repo', 'feature'] as const;
const INTRINSIC_FIELDS = ['surface', 'traffic', 'billing', 'tenant', 'team', 'model'] as const;

/** True when every request route `later` could match is already taken by `earlier` (earlier has no condition `later` lacks or differs on). */
function covers(earlier: RouteSpec, later: RouteSpec): boolean {
  return MATCH_FIELDS.every((f) => earlier.match[f] === undefined || earlier.match[f] === later.match[f]);
}

export function validatePolicy(src: PolicySource, o: { experimentalSubscription: boolean }): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: (typeof ERROR_CODES)[number], path: string, message: string): void => void errors.push({ code, path, message });
  const warn = (code: (typeof WARNING_CODES)[number], path: string, message: string): void => void warnings.push({ code, path, message });
  const { policy, prices, keys } = src;
  const flag = o.experimentalSubscription;

  // Maps, never plain-object lookups: provider names come from policy text and "constructor" must not resolve to a built-in.
  const providers = new Map<string, ProviderSpec['format']>(Object.entries(policy.providers).map(([n, p]) => [n, p.format]));

  for (const [name, p] of Object.entries(policy.providers)) {
    const at = `providers.${name}`;
    if (p.credential === 'passthrough') {
      let ok = false;
      try {
        const u = new URL(p.baseUrl);
        ok = u.protocol === 'https:' && u.hostname === OFFICIAL_HOST[p.format] && u.port === '' && u.username === '' && u.password === '';
      } catch {
        ok = false;
      }
      if (!ok) err('E_PASSTHROUGH_HOST', `${at}.baseUrl`, `credential: passthrough is only allowed with https://${OFFICIAL_HOST[p.format]} (a user's token must never reach another host)`);
      if (!flag) err('E_SUBSCRIPTION_FLAG', `${at}.credential`, 'credential: passthrough needs --experimental-subscription');
    } else if (!ENV_NAME.test(p.credential.env)) {
      err('E_CREDENTIAL_ENV', `${at}.credential.env`, `"${p.credential.env}" is not a valid environment variable name`);
    }
  }

  keys.forEach((k, i) => {
    if (k.billing === 'subscription' && !flag) err('E_SUBSCRIPTION_FLAG', `keys[${i}].billing`, `key ${k.keyId} has billing: subscription, which needs --experimental-subscription`);
  });

  const priced = (pattern: string): boolean => (pattern.includes('*') ? Object.keys(prices.models).some((id) => globMatch(pattern, id)) : lookupModel(prices, pattern) !== null);

  policy.routes.forEach((r, i) => {
    const at = `routes[${i}]`;
    const codingAgentSeen = r.match.traffic !== 'product';
    const codingMessages = r.match.surface === 'anthropic-messages' && r.match.traffic === 'coding-agent';

    if (r.chain.length < 1 || r.chain.length > 3) err('E_CHAIN_LENGTH', `${at}.chain`, `a chain has 1 to 3 providers, this one has ${r.chain.length}`);
    r.chain.forEach((entry, j) => {
      const p = chainProvider(entry);
      const format = providers.get(p);
      if (format === undefined) return void err('E_CHAIN_UNKNOWN_PROVIDER', `${at}.chain[${j}]`, `provider "${p}" is not defined under providers`);
      if (codingMessages && format !== 'anthropic') err('E_CODING_AGENT_FORMAT', `${at}.chain[${j}]`, `coding-agent traffic on anthropic-messages may only chain format: anthropic providers; "${p}" is ${format}`);
    });
    if (codingMessages) {
      r.allowModels?.forEach((m, j) => {
        if (!m.startsWith('claude')) err('E_CODING_AGENT_NON_CLAUDE', `${at}.allowModels[${j}]`, `"${m}" is not a Claude model; Claude Code is not supported through a gateway that routes it to non-Claude models`);
      });
    }

    if (codingAgentSeen) {
      if (r.rewriteModel !== undefined && r.allowBodyRewrite !== true) err('E_BODY_REWRITE', `${at}.rewriteModel`, 'rewriteModel on coding-agent traffic needs allowBodyRewrite: true and a because: reason');
      if (r.allowBodyRewrite === true && (r.because ?? '').trim() === '') err('E_BODY_REWRITE', `${at}.because`, 'allowBodyRewrite: true must name the reason in because:');
    }

    r.allowModels?.forEach((m, j) => {
      if (!priced(m)) err('E_UNPRICED_MODEL', `${at}.allowModels[${j}]`, `"${m}" has no entry in the price table`);
    });
    if (r.rewriteModel !== undefined && lookupModel(prices, r.rewriteModel) === null) err('E_UNPRICED_MODEL', `${at}.rewriteModel`, `"${r.rewriteModel}" has no entry in the price table`);

    r.serverTools?.forEach((t, j) => {
      if (!Object.hasOwn(prices.serverTools, t) && policy.failure.unpricedModel === undefined) {
        err('E_UNPRICED_SERVER_TOOL', `${at}.serverTools[${j}]`, `server tool "${t}" has no price and failure.unpricedModel is not stated`);
      }
    });

    if (r.match.billing === 'subscription' && !flag) err('E_SUBSCRIPTION_FLAG', `${at}.match.billing`, 'a route matching billing: subscription needs --experimental-subscription');
  });

  for (const [id, m] of Object.entries(prices.models)) {
    if (m.maxOutputTokens > m.maxContextTokens) err('E_MODEL_LIMITS', `prices.models.${id}`, `maxOutputTokens (${m.maxOutputTokens}) is larger than maxContextTokens (${m.maxContextTokens})`);
  }

  const names = new Set<string>();
  policy.budgets.forEach((b, i) => {
    const at = `budgets[${i}]`;
    if (names.has(b.name)) err('E_BUDGET_DUP', `${at}.name`, `budget name "${b.name}" is used twice`);
    names.add(b.name);
    if (b.scope === 'session') {
      if (b.window !== undefined) err('E_BUDGET_WINDOW', `${at}.window`, 'a session budget has no window');
    } else if (b.window === undefined || !Object.hasOwn(WINDOW_RANK, b.window)) {
      err('E_BUDGET_WINDOW', `${at}.window`, `window must be day, week or month (UTC) for scope ${b.scope}`);
    }
    if (!(b.usd > 0) || !Number.isFinite(b.usd)) err('E_BUDGET_USD', `${at}.usd`, `usd must be greater than 0, got ${b.usd}`);
  });

  const enforced = policy.budgets.filter((b) => b.mode === 'enforce');
  if (enforced.length > 0 && policy.failure.counterStoreDown.budgets === undefined) {
    err('E_STORE_DOWN_UNSTATED', 'failure.counterStoreDown.budgets', 'state open or closed explicitly: the policy has budgets with mode: enforce');
  }

  // Warnings.
  policy.budgets.forEach((child, i) => {
    const parent = policy.budgets.find(
      (b) => (SCOPE_RANK[b.scope] ?? 0) > (SCOPE_RANK[child.scope] ?? 0) && child.usd > b.usd && (WINDOW_RANK[child.window ?? ''] ?? 0) >= (WINDOW_RANK[b.window ?? ''] ?? 0) && child.window !== undefined,
    );
    if (parent) warn('W_CHILD_BUDGET', `budgets[${i}]`, `${child.scope} budget "${child.name}" (${child.usd} USD) is larger than ${parent.scope} budget "${parent.name}" (${parent.usd} USD)`);
  });

  for (const s of SURFACE_LIST) {
    // A route on anthropic-messages also serves anthropic-count-tokens (decide.ts).
    const serves = (r: RouteSpec): boolean => r.match.surface === undefined || r.match.surface === s || (s === 'anthropic-count-tokens' && r.match.surface === 'anthropic-messages');
    if (!policy.routes.some(serves)) warn('W_SURFACE_NO_ROUTE', 'routes', `no route matches surface ${s}; requests on it get 403 "no route"`);
  }

  policy.routes.forEach((later, j) => {
    const i = policy.routes.findIndex((earlier, k) => k < j && covers(earlier, later));
    if (i >= 0) warn('W_ROUTE_SHADOWED', `routes[${j}]`, `route "${later.name}" can never match: route "${policy.routes[i]?.name}" before it covers it`);
  });

  // A route with header predicates cannot widen the models a key may use: decide also requires the route that matches
  // without them. Approximated statically by the first header-free route with no condition this route lacks or differs on.
  const modelIds = Object.keys(prices.models);
  const allowsId = (r: RouteSpec, id: string): boolean => r.allowModels === undefined || r.allowModels.some((p) => globMatch(p, id));
  policy.routes.forEach((r, j) => {
    if (HEADER_FIELDS.every((k) => r.match[k] === undefined)) return;
    const authz = policy.routes.find((k) => HEADER_FIELDS.every((h) => k.match[h] === undefined) && INTRINSIC_FIELDS.every((f) => k.match[f] === undefined || k.match[f] === r.match[f]));
    if (!authz) {
      warn('W_HEADER_ROUTE_GRANTS', `routes[${j}]`, `route "${r.name}" is reached only through client headers, which cannot grant models; add a route without header conditions that allows them, or its requests get 403`);
      return;
    }
    const extra = modelIds.filter((id) => allowsId(r, id) && !allowsId(authz, id));
    if (extra.length > 0 || (r.allowModels === undefined && authz.allowModels !== undefined)) {
      warn('W_HEADER_ROUTE_GRANTS', `routes[${j}]`, `route "${r.name}" allows models that route "${authz.name}" does not (${extra.join(', ') || 'any model'}); client headers cannot grant them, so those requests get 403`);
    }
    const extraTools = (r.serverTools ?? []).filter((t) => !(authz.serverTools ?? []).includes(t));
    if (extraTools.length > 0) {
      warn('W_HEADER_ROUTE_GRANTS', `routes[${j}].serverTools`, `route "${r.name}" lists server tools that route "${authz.name}" does not (${extraTools.join(', ')}); client headers cannot grant them, so those requests get 403`);
    }
    if (r.rewriteModel !== undefined && !allowsId(authz, r.rewriteModel)) {
      err('E_REWRITE_NOT_AUTHORIZED', `routes[${j}].rewriteModel`, `route "${r.name}" is chosen by client headers and rewrites to "${r.rewriteModel}", which route "${authz.name}" does not allow`);
    }
  });

  // An unpriced server tool is refused on any request that touches an enforced budget (decide.ts), so allow-and-flag
  // cannot admit it there.
  if (policy.failure.unpricedModel === 'allow-and-flag' && enforced.length > 0) {
    policy.routes.forEach((r, j) => {
      const unpriced = (r.serverTools ?? []).filter((t) => !Object.hasOwn(prices.serverTools, t));
      if (unpriced.length > 0) warn('W_UNPRICED_TOOL_ENFORCED', `routes[${j}].serverTools`, `server tools ${unpriced.join(', ')} have no price; with enforced budgets they are refused despite failure.unpricedModel: allow-and-flag`);
    });
  }

  if (policy.reservation.estimator === 'session-aware') {
    policy.budgets.forEach((b, i) => {
      if (b.scope === 'session' && b.onExceed === 'block') warn('W_SESSION_AWARE_BLOCK', `budgets[${i}]`, 'estimator: session-aware with onExceed: block on a session budget; the budget guarantee does not hold');
    });
  }
  if (policy.reservation.serverToolsWithoutMaxUses === 'assume' && enforced.length > 0) {
    warn('W_SERVER_TOOLS_ASSUME', 'reservation.serverToolsWithoutMaxUses', 'assume with an enforced budget: the budget guarantee does not hold for requests with a server tool and no max_uses');
  }
  if (flag) {
    const subscriptionInUse = keys.some((k) => k.billing === 'subscription') || policy.routes.some((r) => r.match.billing === 'subscription');
    const blocking = policy.budgets.findIndex((b) => b.mode === 'enforce' && b.onExceed === 'block');
    if (subscriptionInUse && blocking >= 0) warn('W_SUBSCRIPTION_BLOCK', `budgets[${blocking}]`, 'subscription traffic is priced as API-equivalent cost; an enforced block budget can deny it (subscription budgets default to onExceed: warn)');
  }

  return { errors, warnings };
}
