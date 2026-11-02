import { compilePolicy } from '../policy/compile.js';
import { policySchema } from '../policy/schema.js';
import type { CompiledPolicy, KeyRecord } from '../policy/types.js';
import { hashKey } from './auth.js';

/** Plaintext key accepted by `serve --dev-upstream`. Development only. */
export const DEV_KEY = 'ty_live_dev';
/** Environment variable `serve --dev-upstream` reads the upstream key from (optional; the mock needs none). */
export const DEV_UPSTREAM_KEY_ENV = 'TOKENYARD_DEV_UPSTREAM_KEY';

/**
 * Single-route policy for `serve --dev-upstream`: every Anthropic request from one of `keys` goes to `upstream`.
 * Compiled through `compilePolicy` like any policy, with no budgets, no rate limits and an empty price table
 * (any model is let through and flagged unpriced; no cost is computed).
 */
export function devPolicy(o: { upstream: string; keys: string[]; credential: { env: string }; billing?: KeyRecord['billing'] }): CompiledPolicy {
  const billing = o.billing ?? 'api';
  const policy = policySchema.parse({
    apiVersion: 'tokenyard/v1',
    kind: 'Policy',
    metadata: { name: 'dev' },
    providers: { 'dev-upstream': { format: 'anthropic', baseUrl: o.upstream, credential: { env: o.credential.env } } },
    routes: [{ name: 'dev', chain: ['dev-upstream'] }],
    failure: { unpricedModel: 'allow-and-flag' },
  });
  const keys = o.keys.map((plaintext, i): KeyRecord => ({
    hash: hashKey(plaintext),
    keyId: `dev${i + 1}`,
    tenant: 'dev',
    team: null,
    name: `dev key ${i + 1}`,
    kind: 'developer',
    billing,
  }));
  const prices = { version: 'none', models: {}, modifiers: {}, serverTools: {} };
  return compilePolicy({ dir: '(dev)', policy, prices, keys, normalizedFiles: {} }, 'dev', { experimentalSubscription: billing === 'subscription' });
}
