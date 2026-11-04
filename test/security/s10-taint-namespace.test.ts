// Task 10 minor (marked for Task 25): taint keys for sessions and for keys share one store namespace, told apart by
// the s: and k: prefixes. A client that sets its session id to another key's id must not read or write that key's
// taint set (a secret leaked by one key would otherwise block, or be cleared for, another).
import { expect, test } from 'vitest';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { features, HEAD, source } from '../policy/helpers.js';

const p = compilePolicy(source(`${HEAD}routes:\n  - { name: all, chain: [a] }\nfailure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n`), 'r', { experimentalSubscription: false });
const hit = [{ rule: 'gh', action: 'block' as const, valueHmac: 'h', where: 'history' as const }];

test('S10 a session id equal to a key id gets the session taint key, never the key one', () => {
  const byKey = decide(p, features({ keyId: 'k1', guardrail: { hits: hit } })).taint?.key;
  const bySession = decide(p, features({ keyId: 'k2', attribution: { session: 'k1' }, guardrail: { hits: hit } })).taint?.key;
  expect(byKey).toBe('ty:{acme}:taint:k:k1');
  expect(bySession).toBe('ty:{acme}:taint:s:k1');
});

test('S10 a hostile session id cannot break out of its taint key or the tenant hash tag', () => {
  const key = decide(p, features({ attribution: { session: 'x}:taint:k:k1{acme' } })).taint?.key ?? '';
  expect(key.startsWith('ty:{acme}:taint:s:')).toBe(true);
  expect(key).not.toBe('ty:{acme}:taint:k:k1');
  expect(key.slice('ty:{acme}:'.length)).not.toContain('}');
});
