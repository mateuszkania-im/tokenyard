import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashKey } from '../../src/edge/auth.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { parsePolicyFiles } from '../../src/policy/load-dir.js';
import type { PolicyDoc, RouteSpec } from '../../src/policy/schema.js';
import type { CompiledPolicy, KeyRecord, ProviderSpec } from '../../src/policy/types.js';
import type { PriceTable } from '../../src/pricing/prices.js';

/** Plaintext tokenyard key accepted by the test policy. */
export const TEST_KEY = 'ty_live_test';
/** Environment variable holding the provider key in API-mode tests. */
export const PROVIDER_KEY_ENV = 'TOKENYARD_TEST_PROVIDER_KEY';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'policy');
const read = (f: string): string => readFileSync(join(EXAMPLE, f), 'utf8');

/**
 * examples/policy compiled through `compilePolicy`, with three test changes: both Anthropic providers point at
 * `upstream` with `credential`, the only key is TEST_KEY (developer, tenant acme, team platform, `billing`), and the
 * claude-code route matches that billing and allows `models` (any model when omitted; unknown ones are flagged
 * unpriced by the example's `unpricedModel: allow-and-flag`).
 *
 * A passthrough credential is only valid with the official host (E_PASSTHROUGH_HOST), so for passthrough the policy
 * is compiled against https://api.anthropic.com and the providers are pointed at `upstream` afterwards.
 */
export function testPolicy(o: {
  upstream: string;
  /** Where the `openai` provider points (default `upstream`): tests never reach api.openai.com. */
  openaiUpstream?: string;
  credential?: ProviderSpec['credential'];
  models?: string[];
  billing?: KeyRecord['billing'];
  /** Sets rewriteModel on the claude-code route, with the allowBodyRewrite escape hatch and a reason. */
  rewriteModel?: string;
  /** Last edit of the parsed routes before compiling. */
  editRoutes?: (routes: RouteSpec[]) => void;
  /** Last edit of the parsed price table before compiling. */
  editPrices?: (prices: PriceTable) => void;
  /** Last edit of the whole parsed policy (budgets, rate limits, failure) before compiling. */
  edit?: (policy: PolicyDoc) => void;
  /** Keys added beside TEST_KEY, for example a service key for product routes. */
  extraKeys?: KeyRecord[];
}): CompiledPolicy {
  const credential = o.credential ?? { env: PROVIDER_KEY_ENV };
  const billing = o.billing ?? 'api';
  const src = parsePolicyFiles('examples/policy', { 'policy.yaml': read('policy.yaml'), 'prices.yaml': read('prices.yaml'), 'keys.yaml': read('keys.yaml') });
  const passthrough = credential === 'passthrough';
  for (const name of ['anthropic', 'anthropic-backup']) {
    const p = src.policy.providers[name];
    if (!p) throw new Error(`examples/policy has no provider ${name}`);
    p.baseUrl = passthrough ? 'https://api.anthropic.com' : o.upstream;
    p.credential = credential;
  }
  const oa = src.policy.providers.openai;
  if (oa && !passthrough) {
    oa.baseUrl = o.openaiUpstream ?? o.upstream;
    oa.credential = credential;
  }
  src.keys = [{ hash: hashKey(TEST_KEY), keyId: 'key_test', tenant: 'acme', team: 'platform', name: 'test', kind: 'developer', billing }, ...(o.extraKeys ?? [])];
  const route = src.policy.routes.find((r) => r.name === 'claude-code');
  if (!route) throw new Error('examples/policy has no claude-code route');
  route.match.billing = billing;
  if (o.models === undefined) delete route.allowModels;
  else route.allowModels = o.models;
  if (o.rewriteModel !== undefined) Object.assign(route, { rewriteModel: o.rewriteModel, allowBodyRewrite: true, because: 'test' });
  o.editRoutes?.(src.policy.routes);
  o.edit?.(src.policy);
  o.editPrices?.(src.prices);
  const compiled = compilePolicy(src, 'test', { experimentalSubscription: passthrough || billing === 'subscription' });
  if (!passthrough) return compiled;
  const providers = new Map([...compiled.providers].map(([n, p]) => [n, n.startsWith('anthropic') ? { ...p, baseUrl: o.upstream } : n === 'openai' ? { ...p, baseUrl: o.openaiUpstream ?? o.upstream } : p]));
  return { ...compiled, providers };
}

/**
 * `edit` for testPolicy: every budget in audit mode, so no enforced level applies. Unpriced models and bodies the
 * gateway cannot parse are refused under an enforced level (A2, A5); protocol-fidelity tests that send them use this.
 */
export const auditBudgets = (p: PolicyDoc): void => {
  p.budgets = p.budgets.map((b) => ({ ...b, mode: 'audit' as const }));
};
