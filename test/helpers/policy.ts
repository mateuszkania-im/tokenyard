import { devPolicy } from '../../src/edge/dev-policy.js';
import type { CompiledPolicy, KeyRecord, ProviderSpec } from '../../src/policy/types.js';

/** Plaintext tokenyard key accepted by the test policy. */
export const TEST_KEY = 'ty_live_test';
/** Environment variable holding the provider key in API-mode tests. */
export const PROVIDER_KEY_ENV = 'TOKENYARD_TEST_PROVIDER_KEY';

/**
 * Single-route policy that forwards every Anthropic request to `upstream`
 * (the first and only provider). Task 10 rebuilds this from examples/policy.
 */
export function testPolicy(o: {
  upstream: string;
  credential?: ProviderSpec['credential'];
  models?: string[];
  billing?: KeyRecord['billing'];
}): CompiledPolicy {
  return devPolicy({
    upstream: o.upstream,
    keys: [TEST_KEY],
    credential: o.credential ?? { env: PROVIDER_KEY_ENV },
    models: o.models ?? [],
    billing: o.billing,
  });
}
