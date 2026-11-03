// S10-2 (coordinator finding, Task 10, MEDIUM): header-derived route predicates (requestClass, agentType, repo,
// feature) never grant access. The model is authorised by the first route matching on key-derived and
// request-intrinsic fields only; a header may choose a chain among what that route allows, never widen it.
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import type { RequestFeatures } from '../../src/policy/types.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { authHeaders, msgBody, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { features, HEAD, source } from '../policy/helpers.js';
import { closeAll, closers, gw } from './common.js';

afterEach(closeAll);
const STORE = 'failure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n  unpricedModel: allow-and-flag\n';
const policy = compilePolicy(source(`${HEAD}routes:
  - { name: by-class, match: { requestClass: compaction }, chain: [b], allowModels: ["claude-*"] }
  - { name: by-agent, match: { agentType: Explore }, chain: [b], allowModels: ["claude-*"] }
  - { name: by-repo, match: { repo: acme/web }, chain: [b], allowModels: ["claude-*"] }
  - { name: by-feature, match: { feature: summary }, chain: [b], allowModels: ["claude-*"] }
  - { name: base, chain: [a], allowModels: ["claude-haiku-*"] }
${STORE}`), 'r1', { experimentalSubscription: false });

test.each<[string, Partial<RequestFeatures['attribution']>]>([
  ['requestClass', { requestClass: 'compaction' }],
  ['agentType', { agentType: 'Explore' }],
  ['repo', { repo: 'acme/web' }],
  ['feature', { feature: 'summary' }],
])('S10-2 a forged %s header cannot reach a model the header-free route refuses', (_name, attribution) => {
  const plan = decide(policy, features({ model: 'claude-opus-5-5', attribution }));
  expect(plan.preBlock).toBe('model-not-allowed');
  // The header does choose the chain for a model the key may use anyway.
  const ok = decide(policy, features({ model: 'claude-haiku-5-5', attribution }));
  expect(ok).toMatchObject({ preBlock: null, chain: [{ provider: 'b' }] });
});

test('S10-2 a route reachable only through headers authorises nothing', () => {
  const only = compilePolicy(source(`${HEAD}routes:\n  - { name: feat, match: { feature: summary }, chain: [a] }\n${STORE}`), 'r', { experimentalSubscription: false });
  expect(decide(only, features({ attribution: { feature: 'summary' } })).preBlock).toBe('no-route');
});

test('S10-2 end to end: x-claude-code-request-class: compaction does not unlock Opus', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gw(testPolicy({
    upstream: mock.url,
    models: ['claude-haiku-*'],
    editRoutes: (routes) => routes.unshift({ name: 'compaction', match: { requestClass: 'compaction' }, chain: ['anthropic'], allowModels: ['claude-*'] }),
  }));
  const r = await send(g.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-claude-code-request-class': 'compaction' }, body: msgBody({ model: 'claude-opus-5-5' }) });
  expect(r.status).toBe(403);
  expect(mock.received).toHaveLength(0);
});
