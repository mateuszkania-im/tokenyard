import { expect, test } from 'vitest';
import { buildReport } from '../../src/report/report.js';
import { renderReportTerminal } from '../../src/report/render-terminal.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { baseRecord } from '../helpers/trace.js';

function rec(id: string, team: string | null, cls: string | null, cost: number | null, tenant = 'acme'): TraceRecord {
  const b = baseRecord({ id, team, tenant });
  b.attribution = { ...b.attribution, requestClass: cls };
  b.outcome = { ...b.outcome, costMicroUsd: cost };
  return { ...b, instance: 'i', seq: 1 };
}
const records = [rec('1', 'web', 'main', 1_500_000), rec('2', 'web', 'subagent', 500_000), rec('3', 'data', 'main', 2_000_000), rec('4', null, null, null)];

test('report splits cost by team and by request class; totals equal the sum of records', () => {
  const byTeam = buildReport(records, ['team']);
  expect(byTeam.groups.map((g) => [g.key.team, g.requests, g.costMicroUsd])).toEqual([
    ['web', 2, 2_000_000],
    ['data', 1, 2_000_000],
    ['(none)', 1, 0],
  ]);
  const byClass = buildReport(records, ['requestClass']);
  expect(byClass.groups.map((g) => [g.key.requestClass, g.costMicroUsd])).toEqual([
    ['main', 3_500_000],
    ['subagent', 500_000],
    ['(none)', 0],
  ]);
  for (const r of [byTeam, byClass, buildReport(records, ['team', 'requestClass'])]) {
    expect(r.totals.costMicroUsd).toBe(4_000_000);
    expect(r.groups.reduce((s, g) => s + g.costMicroUsd, 0)).toBe(r.totals.costMicroUsd);
    expect(r.groups.reduce((s, g) => s + g.requests, 0)).toBe(4);
  }
  expect(byTeam.totals.unpriced).toBe(1);
});

test('terminal report prints dollars, shares and totals without colour codes or arrows', () => {
  const text = renderReportTerminal(buildReport(records, ['team']));
  expect(text).toContain('team');
  expect(text).toContain('$2.0000');
  expect(text).toContain('total');
  expect(text).toContain('$4.0000');
  expect(text.includes(String.fromCharCode(27)) || text.includes('\u2192')).toBe(false);
});
