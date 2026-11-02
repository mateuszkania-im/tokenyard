import { expect, test } from 'vitest';
import type { LedgerLine, TraceRecord } from '../../src/ledger/record.js';
import { budgetKey } from '../../src/limits/keys.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { warmupEntries } from '../../src/limits/warmup.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { baseRecord } from '../helpers/trace.js';
import { HEAD, source } from '../policy/helpers.js';

const POLICY = compilePolicy(source(`${HEAD}routes:
  - { name: all, chain: [a] }
budgets:
  - { name: org-month, scope: tenant, window: month, usd: 6000 }
  - { name: team-day, scope: team, window: day, usd: 300 }
  - { name: key-week, scope: key, window: week, usd: 40 }
  - { name: repo-day, scope: repo, window: day, usd: 20 }
  - { name: session, scope: session, usd: 25 }
  - { name: audit-repo, scope: repo, window: day, usd: 5, mode: audit }
failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
`), 'r1', { experimentalSubscription: false });

const NOW = Date.UTC(2026, 10, 4, 15, 30);
const DAY = 86_400_000;

function rec(ts: string, cost: number | null, o: Partial<TraceRecord> = {}, attr: Partial<TraceRecord['attribution']> = {}): TraceRecord {
  const b = baseRecord({ ts, keyId: 'k1', ...o });
  return { ...b, instance: 'i1', seq: 1, attribution: { ...b.attribution, ...attr }, outcome: { ...b.outcome, costMicroUsd: cost } };
}

async function* lines(xs: LedgerLine[]): AsyncIterable<LedgerLine> {
  yield* xs;
}

test('sums recorded spend per budget key in the windows that contain now; session budgets take every record', async () => {
  const entries = await warmupEntries(lines([
    { v: 1, kind: 'segment', instance: 'i1', startedAt: '2026-11-04T00:00:00.000Z', firstSeq: 1 },
    rec('2026-11-04T10:00:00.000Z', 1_000),
    rec('2026-11-03T10:00:00.000Z', 500),
    rec('2026-10-31T10:00:00.000Z', 200),
    rec('2026-11-04T11:00:00.000Z', null),
    rec('2026-11-04T12:00:00.000Z', 300, {}, { repo: null, session: null }),
    rec('2026-11-04T12:00:00.000Z', 50, { tenant: 'beta', team: null, keyId: 'k9' }, { repo: null, session: null }),
    { v: 1, kind: 'heartbeat', instance: 'i1', ts: '2026-11-04T12:00:00.000Z', seq: 6 },
  ]), POLICY, NOW);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const at = (k: string) => byKey.get(k);
  expect(at(budgetKey('acme', 'org-month', 'acme', '2026-11-01'))).toEqual({ key: budgetKey('acme', 'org-month', 'acme', '2026-11-01'), spentMicroUsd: 1_800, ttlMs: Date.UTC(2026, 11, 1) + DAY - NOW });
  expect(at(budgetKey('acme', 'team-day', 'web', '2026-11-04'))?.spentMicroUsd).toBe(1_300);
  expect(at(budgetKey('acme', 'team-day', 'web', '2026-11-04'))?.ttlMs).toBe(Date.UTC(2026, 10, 5) + DAY - NOW);
  expect(at(budgetKey('acme', 'key-week', 'k1', '2026-11-02'))?.spentMicroUsd).toBe(1_800);
  expect(at(budgetKey('acme', 'repo-day', 'shop', '2026-11-04'))?.spentMicroUsd).toBe(1_000);
  // A missing header is charged to "(unattributed)" on enforced levels, as decide does; audit levels skip it.
  expect(at(budgetKey('acme', 'repo-day', '(unattributed)', '2026-11-04'))?.spentMicroUsd).toBe(300);
  expect(at(budgetKey('acme', 'audit-repo', 'shop', '2026-11-04'))?.spentMicroUsd).toBe(1_000);
  expect(at(budgetKey('acme', 'audit-repo', '(unattributed)', '2026-11-04'))).toBeUndefined();
  expect(at(budgetKey('acme', 'session', 'sess', null))).toEqual({ key: budgetKey('acme', 'session', 'sess', null), spentMicroUsd: 1_700, ttlMs: 30 * DAY });
  expect(at(budgetKey('acme', 'session', '(unattributed)', null))?.spentMicroUsd).toBe(300);
  // Other tenant, no team: tenant and key levels only, plus the unattributed header levels.
  expect(entries.filter((e) => e.key.startsWith('ty:{beta}:')).map((e) => e.key).sort()).toEqual([
    budgetKey('beta', 'key-week', 'k9', '2026-11-02'),
    budgetKey('beta', 'org-month', 'beta', '2026-11-01'),
    budgetKey('beta', 'repo-day', '(unattributed)', '2026-11-04'),
    budgetKey('beta', 'session', '(unattributed)', null),
  ].sort());
  expect(entries.every((e) => e.spentMicroUsd > 0 && Number.isInteger(e.spentMicroUsd) && e.ttlMs > 0)).toBe(true);
});

test('seeded entries make the next admit see the recorded spend', async () => {
  const entries = await warmupEntries(lines([rec('2026-11-04T10:00:00.000Z', 6_000_000_000)]), POLICY, NOW);
  const store = createMemoryStore({ clock: () => NOW });
  await store.seed(entries);
  const key = budgetKey('acme', 'org-month', 'acme', '2026-11-01');
  expect((await store.snapshot([key]))[key]).toEqual({ spent: 6_000_000_000, reserved: 0 });
  const a = await store.admit({ id: 'x', policyRevision: 'r1', route: 'all', chain: [], reservations: [{ budget: 'org-month', key, limitMicroUsd: 6_000_000_000, estMicroUsd: 1, enforce: true, resetsAt: '2026-12-01T00:00:00.000Z' }], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [] });
  expect(a.failed).toEqual({ kind: 'budget', name: 'org-month', spentMicroUsd: 6_000_000_000 });
});
