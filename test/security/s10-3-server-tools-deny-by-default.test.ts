// S10-3 and S10-3b (coordinator findings, Task 10, MEDIUM): server tools are denied unless the matched route lists
// them (null lists none), a header-selected route cannot unlock one, tool search is priced with no fee and a
// 10-iteration loop, and a still-unpriced server tool is refused whenever an enforced budget applies.
import { expect, test } from 'vitest';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { resolve } from '../../src/policy/resolve.js';
import { features, HEAD, source } from '../policy/helpers.js';

const STORE = 'failure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n  unpricedModel: allow-and-flag\n';
const BUDGET = 'budgets:\n  - { name: org, scope: tenant, window: day, usd: 100 }\n';
const compile = (routes: string, budgets = BUDGET) => compilePolicy(source(`${HEAD}routes:\n${routes}${budgets}${STORE}`), 'r', { experimentalSubscription: false });
const tool = (type: string, maxUses: number | null = 3) => ({ serverTools: [{ type, maxUses }], boundKind: 'context-window' as const, inputTokensBound: 1_000_000 });

test('S10-3 a route that lists no server tool refuses web_search, and resolve answers 403 permission_error', () => {
  const p = compile('  - { name: none, chain: [a] }\n');
  const plan = decide(p, features(tool('web_search_20250305')));
  expect(plan.preBlock).toBe('server-tool-not-allowed');
  expect(resolve(p, plan, null).block).toMatchObject({ status: 403, type: 'permission_error', reason: 'server-tool-not-allowed' });
});

test('S10-3 only the listed tool passes; another one on the same route is refused', () => {
  const p = compile('  - { name: search, chain: [a], serverTools: [web_search] }\n');
  expect(decide(p, features(tool('web_search_20250305'))).preBlock).toBeNull();
  expect(decide(p, features(tool('code_execution_20250825'))).preBlock).toBe('server-tool-not-allowed');
});

test('S10-3 a forged request-class header cannot unlock a tool the header-free route does not list', () => {
  const p = compile('  - { name: c, match: { requestClass: compaction }, chain: [a], serverTools: [web_search, code_execution] }\n  - { name: base, chain: [a], serverTools: [web_search] }\n');
  const plan = decide(p, features({ attribution: { requestClass: 'compaction' }, ...tool('code_execution_20250825') }));
  expect(plan.preBlock).toBe('server-tool-not-allowed');
});

test('S10-3b tool search is priced with no fee and a 10-iteration loop', () => {
  const p = compile('  - { name: all, chain: [a], serverTools: [tool_search_tool_regex] }\n');
  expect(p.prices.serverTools.tool_search_tool_regex).toMatchObject({ perUseUsd: 0, maxIterations: 10 });
  expect(p.prices.serverTools.tool_search_tool_bm25).toMatchObject({ perUseUsd: 0, maxIterations: 10 });
  expect(decide(p, features(tool('tool_search_tool_regex_20251119', null))).preBlock).toBeNull();
});

test('S10-3b an unpriced server tool is refused under an enforced budget whatever failure.unpricedModel says, allowed (flagged) only without one', () => {
  const routes = '  - { name: all, chain: [a], serverTools: [code_execution, brand_new_tool] }\n';
  const enforced = compile(routes);
  expect(enforced.failure.unpricedModel).toBe('allow-and-flag');
  expect(decide(enforced, features(tool('brand_new_tool_20260101'))).preBlock).toBe('unpriced');
  const audit = compile(routes, 'budgets:\n  - { name: d, scope: key, window: day, usd: 5, mode: audit }\n');
  expect(decide(audit, features(tool('brand_new_tool_20260101'))).preBlock).toBeNull();
});
