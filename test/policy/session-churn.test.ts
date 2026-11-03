// S-V2-1: session-scoped state bounded against client-chosen session ids. The policy sets the idle TTL of session
// keys and the new sessions one key may start per hour; decide puts both into the plan; resolve refuses over the limit.
import { expect, test } from 'vitest';
import { retryable } from '../../src/edge/errors.js';
import { budgetKey, newSessionsKey, sessionKey } from '../../src/limits/keys.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { resolve } from '../../src/policy/resolve.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import { features, HEAD, source } from './helpers.js';

const ROUTES = 'routes:\n  - { name: all, chain: [a] }\nfailure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n';
const SESSION_BUDGET = 'budgets:\n  - { name: session, scope: session, usd: 25, onExceed: block }\n';
const compile = (extra = ''): CompiledPolicy => compilePolicy(source(`${HEAD}${ROUTES}${SESSION_BUDGET}${extra}`), 'r1', { experimentalSubscription: false });

test('defaults: session keys idle out after 24 hours, and a key may start 1,000 new sessions an hour', () => {
  expect(compile().sessions).toEqual({ idleTtlHours: 24, newPerKeyPerHour: 1_000, newPerServiceKeyPerHour: 10_000 });
  expect(compile('sessions: { idleTtlHours: 2, newPerKeyPerHour: 50 }\n').sessions).toEqual({ idleTtlHours: 2, newPerKeyPerHour: 50, newPerServiceKeyPerHour: 10_000 });
});

test('the options are validated: whole hours from 1 to 720, a positive whole number of sessions', () => {
  for (const bad of ['{ idleTtlHours: 0 }', '{ idleTtlHours: 721 }', '{ newPerKeyPerHour: 0 }', '{ newPerKeyPerHour: 2.5 }', '{ newPerKeyPerHour: -1 }', '{ perKey: 5 }']) {
    expect(() => compile(`sessions: ${bad}\n`), bad).toThrow(/E_SCHEMA[\s\S]*sessions/);
  }
});

test('a request with a session carries the new-session check and the idle TTL of its session level', () => {
  const p = compile('sessions: { idleTtlHours: 2, newPerKeyPerHour: 50 }\n');
  const plan = decide(p, features({ attribution: { session: 's1' } }));
  expect(plan.newSession).toEqual({ limit: 'sessions.newPerKeyPerHour', markerKey: sessionKey('acme', 's1'), key: newSessionsKey('acme', 'k1'), emissionMs: 72_000, burst: 50, ttlMs: 7_200_000 });
  expect(plan.sessionIdleTtlMs).toBe(7_200_000);
  expect(plan.reservations.map((r) => r.key)).toEqual([budgetKey('acme', 'session', 's1', null)]);
  // A last-turn secret still names the session, so a new session that only sends secrets is counted too.
  const secret = decide(p, features({ attribution: { session: 's2' }, guardrail: { hits: [{ rule: 'gh', action: 'block', valueHmac: 'h', where: 'last-turn' }] } }));
  expect(secret.preBlock).toBe('secret');
  expect(secret.newSession?.markerKey).toBe(sessionKey('acme', 's2'));
});

test('a request without a session has no new-session check', () => {
  expect(decide(compile(), features()).newSession ?? null).toBeNull();
});

test('over the limit: 429 session-churn naming the option, without retry-after and never retried', () => {
  const p = compile();
  const plan = decide(p, features({ attribution: { session: 's1' } }));
  const d = resolve(p, plan, { admitted: false, failed: { kind: 'sessions', name: 'sessions.newPerKeyPerHour', retryAfterMs: 3_600 }, audit: [], totals: [] });
  expect(d.action).toBe('block');
  expect(d.block).toMatchObject({ status: 429, type: 'rate_limit_error', reason: 'session-churn', retryAfterS: null });
  expect(d.block?.message).toMatch(/1000 new sessions per hour \(sessions\.newPerKeyPerHour\)/);
  expect(retryable('session-churn')).toBe(false);
});

// Follow-up ruling: service keys (product traffic) get their own default, and any key can carry its own limit.
const KEYS = [
  { hash: 'a'.repeat(64), keyId: 'dev', tenant: 'acme', team: 'web', name: 'dev', kind: 'developer', billing: 'api' },
  { hash: 'b'.repeat(64), keyId: 'svc', tenant: 'acme', team: 'web', name: 'svc', kind: 'service', billing: 'api' },
  { hash: 'c'.repeat(64), keyId: 'ci', tenant: 'acme', team: 'web', name: 'ci', kind: 'service', billing: 'api', maxNewSessionsPerHour: 50_000 },
  { hash: 'd'.repeat(64), keyId: 'quiet', tenant: 'acme', team: 'web', name: 'quiet', kind: 'developer', billing: 'api', maxNewSessionsPerHour: 10 },
];
const keysYaml = (keys: unknown[]): string => keys.map((k) => `- ${JSON.stringify(k)}`).join('\n');
const withKeys = (keys: unknown[] = KEYS, extra = ''): CompiledPolicy => compilePolicy(source(`${HEAD}${ROUTES}${SESSION_BUDGET}${extra}`, keysYaml(keys)), 'r1', { experimentalSubscription: false });
const burst = (p: CompiledPolicy, keyId: string, traffic: 'coding-agent' | 'product' = 'coding-agent'): number | undefined => decide(p, features({ keyId, traffic, attribution: { session: 's1' } })).newSession?.burst;

test('service keys default to 10,000 new sessions an hour, developer keys to 1,000; both are policy options', () => {
  const p = withKeys();
  expect(p.sessions).toEqual({ idleTtlHours: 24, newPerKeyPerHour: 1_000, newPerServiceKeyPerHour: 10_000 });
  expect(burst(p, 'dev')).toBe(1_000);
  expect(burst(p, 'svc', 'product')).toBe(10_000);
  const q = withKeys(KEYS, 'sessions: { newPerKeyPerHour: 200, newPerServiceKeyPerHour: 3000 }\n');
  expect(burst(q, 'dev')).toBe(200);
  expect(burst(q, 'svc', 'product')).toBe(3_000);
  expect(decide(q, features({ keyId: 'svc', traffic: 'product', attribution: { session: 's1' } })).newSession?.emissionMs).toBe(1_200);
});

test('a key may carry its own limit (maxNewSessionsPerHour in keys.yaml), above or below its default', () => {
  const p = withKeys();
  expect(burst(p, 'ci', 'product')).toBe(50_000);
  expect(burst(p, 'quiet')).toBe(10);
});

test('the per-key limit is validated: a positive whole number up to 1,000,000', () => {
  for (const bad of [0, -5, 2.5, 1_000_001, '100']) {
    expect(() => withKeys([{ ...KEYS[0], maxNewSessionsPerHour: bad }]), String(bad)).toThrow(/E_SCHEMA[\s\S]*maxNewSessionsPerHour/);
  }
  expect(() => compile('sessions: { newPerServiceKeyPerHour: 0 }\n')).toThrow(/E_SCHEMA[\s\S]*sessions/);
});

test('the 429 names where the limit comes from', () => {
  const p = withKeys();
  const msg = (keyId: string, traffic: 'coding-agent' | 'product' = 'coding-agent'): string => {
    const plan = decide(p, features({ keyId, traffic, attribution: { session: 's1' } }));
    return resolve(p, plan, { admitted: false, failed: { kind: 'sessions', name: plan.newSession?.limit ?? '', retryAfterMs: 1 }, audit: [], totals: [] }).block?.message ?? '';
  };
  expect(msg('svc', 'product')).toContain('more than 10000 new sessions per hour (sessions.newPerServiceKeyPerHour)');
  expect(msg('quiet')).toContain('more than 10 new sessions per hour (maxNewSessionsPerHour in keys.yaml)');
});
