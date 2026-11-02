// Policy document schema (spec 6.3). Shape only; the semantic rules of 6.4 live in validate.ts. Pure.
import { z } from 'zod';

const SURFACES = ['anthropic-messages', 'anthropic-count-tokens', 'openai-responses', 'openai-chat'] as const;
const name = z.string().min(1);
/** A file in the policy directory: a bare name with an optional `./`. No path separators, so a policy cannot read outside its directory. */
const fileRef = z.string().regex(/^(\.\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/, 'must be a file name in the policy directory');
const httpUrl = z.string().refine((s) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

const provider = z.strictObject({
  format: z.enum(['anthropic', 'openai']),
  baseUrl: httpUrl,
  // The env var name is checked syntactically in validate.ts (E_CREDENTIAL_ENV); whether it is set is a runtime matter.
  credential: z.union([z.strictObject({ env: z.string() }), z.literal('passthrough')]),
});

const route = z.strictObject({
  name,
  match: z
    .strictObject({
      surface: z.enum(SURFACES).optional(),
      traffic: z.enum(['coding-agent', 'product']).optional(),
      billing: z.enum(['api', 'subscription']).optional(),
      feature: name.optional(),
    })
    .default({}),
  chain: z.array(name),
  allowModels: z.array(name).optional(),
  rewriteModel: name.optional(),
  allowBodyRewrite: z.boolean().optional(),
  because: z.string().optional(),
  /** Server tool types this route lets through (for example `web_search`); each needs a price or an explicit `failure.unpricedModel`. */
  serverTools: z.array(name).optional(),
  criticality: z.enum(['standard', 'sheddable']).optional(),
  reserveOutputTokens: z.number().int().positive().optional(),
});

const budget = z.strictObject({
  name,
  scope: z.enum(['tenant', 'team', 'key', 'session']),
  // `window` and `usd` are checked in validate.ts (E_BUDGET_WINDOW, E_BUDGET_USD) so each failure has its own code.
  window: z.string().optional(),
  usd: z.number(),
  onExceed: z.enum(['block', 'warn']).default('block'),
  mode: z.enum(['enforce', 'audit']).default('enforce'),
});

const rateLimit = z
  .strictObject({
    name,
    scope: z.enum(['tenant', 'team', 'key']),
    rpm: z.number().positive().optional(),
    burst: z.number().int().positive().optional(),
    concurrentStreams: z.number().int().positive().optional(),
  })
  .refine((r) => r.rpm !== undefined || r.concurrentStreams !== undefined, 'needs rpm or concurrentStreams');

const reservation = z.strictObject({
  estimator: z.enum(['worst-case', 'session-aware']).default('worst-case'),
  onOverrun: z.enum(['allow-and-debit']).default('allow-and-debit'),
  serverToolsWithoutMaxUses: z.enum(['block', 'assume']).default('block'),
  assumedMaxUses: z.number().int().positive().default(25),
});

const guardrails = z.strictObject({
  secrets: z
    .strictObject({
      rules: z.literal('default').default('default'),
      codingAgent: z.enum(['block', 'warn']).default('block'),
      product: z.enum(['block', 'warn', 'redact']).default('redact'),
      entropyOnly: z.enum(['warn']).default('warn'),
      taintTtlHours: z.number().positive().default(24),
    })
    .prefault({}),
  pii: z.strictObject({ product: z.enum(['block', 'warn', 'redact']).default('redact') }).prefault({}),
});

const failure = z.strictObject({
  // Both fields stay optional on purpose: validate.ts requires `budgets` to be stated, and a server tool without a price
  // is only covered when `unpricedModel` is stated (E_STORE_DOWN_UNSTATED, E_UNPRICED_SERVER_TOOL).
  counterStoreDown: z.strictObject({ rateLimits: z.enum(['open', 'closed']).default('open'), budgets: z.enum(['open', 'closed']).optional() }).prefault({}),
  unpricedModel: z.enum(['block', 'allow-and-flag']).optional(),
  breaker: z
    .strictObject({
      minRequests: z.number().int().positive().default(20),
      failureRatio: z.number().gt(0).max(1).default(0.5),
      windowSeconds: z.number().positive().default(30),
      openSeconds: z.number().positive().default(30),
    })
    .prefault({}),
  retryBudgetRatio: z.number().min(0).max(1).default(0.1),
});

const ci = z.strictObject({
  failOn: z
    .strictObject({ cutSessions: z.number().int().nonnegative().default(0), costIncreasePct: z.number().nonnegative().default(10) })
    .prefault({}),
});

export const policySchema = z.strictObject({
  apiVersion: z.literal('tokenyard/v1'),
  kind: z.literal('Policy'),
  metadata: z.strictObject({ name, owners: z.array(z.string()).optional() }),
  pricing: fileRef.default('./prices.yaml'),
  keys: fileRef.default('./keys.yaml'),
  providers: z.record(name, provider),
  tenants: z.record(name, z.strictObject({ teams: z.array(name).default([]) })).default({}),
  routes: z.array(route),
  budgets: z.array(budget).default([]),
  reservation: reservation.prefault({}),
  rateLimits: z.array(rateLimit).default([]),
  guardrails: guardrails.prefault({}),
  failure: failure.prefault({}),
  ci: ci.prefault({}),
});

export type PolicyDoc = z.infer<typeof policySchema>;
export type RouteSpec = PolicyDoc['routes'][number];
export type BudgetSpec = PolicyDoc['budgets'][number];

export const keyRecordSchema = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 hex digest'),
  keyId: name,
  tenant: name,
  team: name.nullable(),
  name,
  kind: z.enum(['developer', 'service']),
  billing: z.enum(['api', 'subscription']),
});
export const keysFileSchema = z.array(keyRecordSchema);

export const SURFACE_LIST: readonly (typeof SURFACES)[number][] = SURFACES;
