// Spec 6.5 types, copied verbatim, plus the shared policy-side types the edge needs.
// Pure module: types only.

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
  | 'server-tool-no-max-uses';

/** A note carried on a plan: guardrail warns and audit-mode notes. The spec names the type without a shape; Task 10 may refine it. */
export interface Warning {
  kind: string;
  message: string;
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

/**
 * Placeholder route shape for Tasks 4 to 9 (single-route policies from test/helpers/policy.ts
 * and `serve --dev-upstream`). Task 10 replaces it with the compiled route from the policy schema.
 */
export interface CompiledRoute {
  name: string;
  surfaces: readonly Surface[];
  /** Model ids this route serves; `GET /v1/models` lists the ones containing `claude`. */
  models: readonly string[];
  /** Provider names in chain order. */
  chain: readonly string[];
}

/** Compiled, immutable policy snapshot. Task 10 adds the remaining fields (budgets, rate limits, prices, ...). */
export interface CompiledPolicy {
  revision: string;
  providers: ReadonlyMap<string, ProviderSpec>;
  keysByHash: ReadonlyMap<string, KeyRecord>;
  routes: readonly CompiledRoute[];
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
  reservations: Array<{ budget: string; key: string; limitMicroUsd: number; estMicroUsd: number; enforce: boolean }>;
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
