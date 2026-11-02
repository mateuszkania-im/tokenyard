import type { CompiledPolicy, KeyRecord, ProviderSpec } from '../policy/types.js';
import { hashKey } from './auth.js';

/** Plaintext key accepted by `serve --dev-upstream`. Development only. */
export const DEV_KEY = 'ty_live_dev';
/** Environment variable `serve --dev-upstream` reads the upstream key from (optional; the mock needs none). */
export const DEV_UPSTREAM_KEY_ENV = 'TOKENYARD_DEV_UPSTREAM_KEY';

/**
 * Single-route policy: every Anthropic request from one of `keys` goes to `upstream`.
 * Used by `serve --dev-upstream` and by test/helpers/policy.ts.
 */
export function devPolicy(o: {
  upstream: string;
  keys: string[];
  credential: ProviderSpec['credential'];
  models: string[];
}): CompiledPolicy {
  const provider: ProviderSpec = { name: 'dev-upstream', format: 'anthropic', baseUrl: o.upstream, credential: o.credential };
  const keys = o.keys.map((plaintext, i): KeyRecord => ({
    hash: hashKey(plaintext),
    keyId: `dev${i + 1}`,
    tenant: 'dev',
    team: null,
    name: `dev key ${i + 1}`,
    kind: 'developer',
    billing: 'api',
  }));
  return {
    revision: 'dev',
    providers: new Map([[provider.name, provider]]),
    keysByHash: new Map(keys.map((k) => [k.hash, k])),
    routes: [{ name: 'dev', surfaces: ['anthropic-messages', 'anthropic-count-tokens'], models: o.models, chain: [provider.name] }],
    candidate: null,
  };
}
