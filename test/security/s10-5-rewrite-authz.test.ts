// S10-5 (coordinator finding, Task 10, MEDIUM): a header-matched route's rewriteModel must not widen the served
// model. When a rewrite happens decide requires the target to be allowed by the selected route and by the header-free
// authorising route (else model-not-allowed), and validation reports E_REWRITE_NOT_AUTHORIZED statically.
import { expect, test } from 'vitest';
import { compilePolicy, PolicyInvalidError } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { features, HEAD, source } from '../policy/helpers.js';

const STORE = 'failure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n  unpricedModel: allow-and-flag\n';
const compile = (routes: string) => compilePolicy(source(`${HEAD}routes:\n${routes}${STORE}`), 'r', { experimentalSubscription: false });

test('S10-5 a feature header cannot rewrite a haiku-only key to Opus', () => {
  const p = compile(`  - { name: summary, match: { feature: summary }, chain: [a], rewriteModel: claude-opus-5-5, allowBodyRewrite: true, because: test }
  - { name: product, match: { traffic: product }, chain: [a], allowModels: ["claude-haiku-*"] }
  - { name: rest, chain: [a] }
`);
  const plan = decide(p, features({ traffic: 'product', model: 'claude-haiku-5-5', attribution: { feature: 'summary' } }));
  expect(plan).toMatchObject({ route: 'summary', preBlock: 'model-not-allowed' });
  // without the header the request is served as asked
  expect(decide(p, features({ traffic: 'product', model: 'claude-haiku-5-5' })).preBlock).toBeNull();
});

test('S10-5 a rewrite inside what both routes allow is served and priced at the target', () => {
  const p = compile(`  - { name: own, match: { traffic: product, feature: own }, chain: [a], allowModels: ["claude-haiku-*", "claude-sonnet-*"], rewriteModel: claude-sonnet-5-5 }
  - { name: product, match: { traffic: product }, chain: [a], allowModels: ["claude-haiku-*", "claude-sonnet-*"] }
`);
  expect(decide(p, features({ traffic: 'product', model: 'claude-haiku-5-5', attribution: { feature: 'own' } }))).toMatchObject({ preBlock: null, chain: [{ upstreamModel: 'claude-sonnet-5-5', rewritesModel: true }] });
});

test('S10-5 validation refuses a header-selected route whose rewrite target the authorising route does not allow', () => {
  const yaml = `${HEAD}routes:
  - { name: by-feature, match: { feature: summary, traffic: product }, chain: [a], rewriteModel: claude-opus-5-5 }
  - { name: product, match: { traffic: product }, chain: [a], allowModels: ["claude-haiku-*"] }
${STORE}`;
  expect(() => compilePolicy(source(yaml), 'r', { experimentalSubscription: false })).toThrow(PolicyInvalidError);
  try {
    compilePolicy(source(yaml), 'r', { experimentalSubscription: false });
  } catch (e) {
    expect(JSON.stringify((e as PolicyInvalidError).issues ?? e)).toContain('E_REWRITE_NOT_AUTHORIZED');
  }
});
