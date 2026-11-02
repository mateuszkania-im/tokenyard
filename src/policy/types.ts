// Spec 6.5 types, copied verbatim, plus the shared policy-side types the edge needs.
// Pure module: types only.
import type { PriceTable } from '../pricing/prices.js';
import type { PolicyDoc } from './schema.js';

export type Surface = 'anthropic-messages' | 'anthropic-count-tokens' | 'openai-responses' | 'openai-chat';

export type BlockReason =
  | 'no-route'
  | 'model-not-allowed'
  | 'secret'
  | 'taint'
  | 'budget'
  | 'rate'
  | 'streams'
  | 'store-down'
  | 'unpriced'
  | 'server-tool-no-max-uses'
  | 'server-tool-not-allowed';         // not in spec 6.5: a server tool type the matched route does not list

/** A note carried on a plan: guardrail warns and what the reservation could not bound. */
export type Warning =
  | { kind: 'guardrail'; rule: string; where: 'last-turn' | 'history' }
  /** The model sent upstream has no price; `failure.unpricedModel: allow-and-flag` let it through at the table's highest prices. */
  | { kind: 'unpriced'; model: string }
  /** The reservation is not a bound for this request (spec 7.4): a server tool without `max_uses` or without a price. */
  | { kind: 'bound-assumed'; reason: 'server-tool-no-max-uses' | 'unpriced-server-tool' }
  /** A server tool type the matched route does not list (the plan carries preBlock server-tool-not-allowed). */
  | { kind: 'server-tool-not-allowed'; type: string };

/** Attribution as sent by the client, before pseudonymisation (spec 9.1 HMACs session, agent, parentAgent and promptId). */
export interface RawAttribution {
  session: string | null;
  agent: string | null;
  parentAgent: string | null;
  requestClass: string | null;
  agentType: string | null;
  promptId: string | null;
  repo: string | null;
  branch: string | null;
  ticket: string | null;
  feature: string | null;
  /** True when a header value was cut or had characters dropped by `sanitizeHeaderValue`. Absent otherwise. */
  sanitized?: true;
}

export interface ProviderSpec {
  name: string;
  format: 'anthropic' | 'openai';
  baseUrl: string;
  credential: { env: string } | 'passthrough';
}

export interface KeyRecord {
  hash: string;
  keyId: string;
  tenant: string;
  team: string | null;
  name: string;
  kind: 'developer' | 'service';
  billing: 'api' | 'subscription';
}

/** A route with its globs compiled to anchored RegExps (spec 6.7: precomputed matchers). */
export interface CompiledRoute {
  name: string;
  /** Absent fields match anything. String fields compare exactly; `model` is the compiled glob. */
  match: {
    surface: Surface | null;
    traffic: 'coding-agent' | 'product' | null;
    billing: 'api' | 'subscription' | null;
    tenant: string | null;
    team: string | null;
    requestClass: string | null;
    agentType: string | null;
    repo: string | null;
    feature: string | null;
    model: RegExp | null;
  };
  /** Providers in policy order; `weight` is set on the entries of a weighted split. */
  chain: ReadonlyArray<{ provider: string; weight: number | null }>;
  /** Compiled `allowModels` globs; null when the route allows any model. */
  allowModels: readonly RegExp[] | null;
  rewriteModel: string | null;
  allowBodyRewrite: boolean;
  serverTools: readonly string[] | null;
  criticality: 'standard' | 'sheddable';
  reserveOutputTokens: number | null;
  /** Model ids `GET /v1/models` shows for this route: priced ids its `allowModels` match, its `rewriteModel`, or every priced id. */
  listedModels: readonly string[];
}

export interface CompiledBudget {
  name: string;
  scope: 'tenant' | 'team' | 'key' | 'repo' | 'session';
  window: 'day' | 'week' | 'month' | null;
  limitMicroUsd: number;
  /** `mode: enforce` with `onExceed: block`; audit and warn levels are reserved and reported, never block. */
  enforce: boolean;
}

export interface CompiledRate {
  name: string;
  scope: 'tenant' | 'team' | 'key';
  /** Milliseconds between requests at the limit: `ceil(60000 / rpm)`. */
  emissionMs: number;
  burst: number;
}

export interface CompiledStreamLimit {
  name: string;
  scope: 'tenant' | 'team' | 'key';
  max: number;
}

/** Compiled, deep-frozen policy snapshot (spec 6.7). Built only by `compilePolicy`. */
export interface CompiledPolicy {
  revision: string;
  priceTableVersion: string;
  providers: ReadonlyMap<string, ProviderSpec>;
  keysByHash: ReadonlyMap<string, KeyRecord>;
  routes: readonly CompiledRoute[];
  budgets: readonly CompiledBudget[];
  rateLimits: readonly CompiledRate[];
  streamLimits: readonly CompiledStreamLimit[];
  reservation: PolicyDoc['reservation'];
  guardrails: PolicyDoc['guardrails'];
  failure: PolicyDoc['failure'];
  ci: PolicyDoc['ci'];
  prices: PriceTable;
  candidate: CompiledPolicy | null;
}

export interface RequestFeatures {
  id: string;                          // gateway request id (ULID), also the reservation id
  ts: number;                          // ms since epoch, supplied by the caller
  surface: 'anthropic-messages' | 'anthropic-count-tokens' | 'openai-responses' | 'openai-chat';
  traffic: 'coding-agent' | 'product'; // from the key
  billing: 'api' | 'subscription';     // from the key
  tenant: string; team: string | null; keyId: string;
  model: string; stream: boolean;
  inputTokensBound: number;            // provable upper bound on billed input tokens per iteration, see 7.3
  boundKind: 'bytes' | 'context-window';
  maxOutputTokens: number | null;
  serverTools: Array<{ type: string; maxUses: number | null }>;
  toolCount: number; thinking: boolean;
  fastMode: boolean;                   // body selects fast mode (speed "fast"); priced at the model's fast rates (Task 9)
  attribution: {
    session: string | null; agent: string | null; parentAgent: string | null;
    requestClass: 'main' | 'subagent' | 'workflow' | 'compaction' | 'auxiliary' | null;
    agentType: string | null; promptId: string | null;
    repo: string | null; branch: string | null; ticket: string | null; feature: string | null;
  };
  guardrail: { hits: GuardrailHit[] }; // computed before decide and before admit, from content the trace never stores
}

export interface GuardrailHit {
  rule: string; action: 'block' | 'warn' | 'redact';
  valueHmac: string;                   // HMAC-SHA256 of the matched value with the deployment salt
  where: 'last-turn' | 'history';
}

export interface Plan {
  policyRevision: string;
  route: string | null;                // null: no route matched
  chain: Array<{ provider: string; upstreamModel: string; rewritesModel: boolean }>;
  reservations: Array<{ budget: string; key: string; limitMicroUsd: number; estMicroUsd: number; enforce: boolean;
                        resetsAt: string | null }>;   // not in spec 6.5: ISO start of the next window (null for session), for the 429 message
  rateChecks: Array<{ limit: string; key: string; emissionMs: number; burst: number; quantity: number }>;
  streamSlots: Array<{ limit: string; key: string; max: number }>;
  taint: {                             // null when the request has no session key and no block hits
    key: string;                       // tenant-tagged session key, or the key id when there is no session
    check: string[];                   // valueHmacs of history hits: blocked if any is in the taint set
    add: Array<{ rule: string; valueHmac: string }>;   // last-turn block hits: written to the taint set
    ttlMs: number;
  } | null;
  preBlock: BlockReason | null;        // decided without counters: model not allowed, no route, last-turn secret
  warnings: Warning[];                 // guardrail warns, audit-mode notes
}

export interface Admission {           // returned by CounterStore.admit(plan)
  admitted: boolean;
  failed: { kind: 'budget' | 'rate' | 'streams' | 'taint'; name: string; spentMicroUsd?: number; retryAfterMs?: number; rule?: string } | null;
  audit: Array<{ name: string; wouldFail: boolean }>;
  totals: Array<{ key: string; spentMicroUsd: number; reservedMicroUsd: number; limitMicroUsd: number }>;  // post-admit, enforced levels
  storeDown?: true;                    // admit could not reach the store; failure.counterStoreDown applied
}

export interface Decision {
  action: 'forward' | 'block';
  block: { status: 400 | 403 | 429 | 503; type: string; reason: BlockReason; message: string; retryAfterS: number | null } | null;
  plan: Plan;
  admission: Admission | null;
}
