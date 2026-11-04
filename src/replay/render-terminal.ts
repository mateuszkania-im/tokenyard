// Terminal report of a replay (spec 9.4: the same sections as the PR comment), plain text without colour. Every label
// that can come from a client header or a policy name goes through stripControls (C0, C1, DEL). Pure.
import { formatUsd } from '../report/render-terminal.js';
import { stripControls } from '../report/sanitize.js';
import type { ReplayResult, Totals } from './engine.js';

const s = (v: string | null): string => (v === null ? '-' : stripControls(v));
const iso = (ms: number): string => new Date(ms).toISOString();

/** Percent with one decimal, rounded down so that anything short of all reads below 100.0%. */
const pctDown = (x: number): string => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;

function change(base: Totals, head: Totals): string {
  const d = head.costMicroUsd - base.costMicroUsd;
  const sign = d < 0 ? '-' : '+';
  const rel = base.costMicroUsd === 0 ? '' : ` (${sign}${((Math.abs(d) / base.costMicroUsd) * 100).toFixed(1)}%)`;
  const estimated = base.estimated || head.estimated ? ', estimated' : '';
  return `${sign}${formatUsd(Math.abs(d))}${rel}${estimated}`;
}

/** Left-aligned columns, two spaces apart, trailing spaces trimmed. */
function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? [];
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

const EXACTNESS_LABEL: Record<ReplayResult['exactness'][number]['exactness'], string> = {
  exact: 'exact',
  'exact-given-assumptions': "exact given the simulation's assumptions",
  estimated: 'estimated',
  'not-computed': 'not computed',
  never: 'never',
};

export function renderTerminal(r: ReplayResult): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]): void => {
    out.push('', title, ...(lines.length > 0 ? lines.map((l) => `  ${l}`) : ['  none']));
  };
  const basis = r.base.costBasis === r.head.costBasis ? r.base.costBasis : 'mixed';

  out.push('tokenyard policy replay');
  out.push(`Traffic: ${iso(r.window.sinceMs)} to ${iso(r.window.untilMs)}, ${r.requests} requests, ${r.sessions} sessions, tenant ${r.tenant === null ? 'all' : s(r.tenant)}.`);
  out.push(`Fidelity: base replay matches recorded decisions on ${pctDown(r.fidelity.agreement)} of requests.`);
  if (r.fidelity.disagreements.length > 0 || r.fidelity.missingInstances.length > 0) out.push('Do not trust the diff below until the fidelity notes are explained.');
  out.push('');
  out.push(
    ...table([
      ['', 'base', 'head', 'change'],
      [`cost (${basis})`, formatUsd(r.base.costMicroUsd), formatUsd(r.head.costMicroUsd), change(r.base, r.head)],
      ['forwarded', String(r.base.forwarded), String(r.head.forwarded), ''],
      ['blocked', String(r.base.blocked), String(r.head.blocked), ''],
      ['sessions cut', String(r.cutSessions.filter((c) => c.policy === 'base').length), String(r.cutSessions.filter((c) => c.policy === 'head').length), ''],
      ['requests rerouted', '', String(r.rerouted.reduce((n, x) => n + x.count, 0)), ''],
    ]),
  );

  section('Fidelity notes', [
    ...r.fidelity.disagreements.map((d) => `${d.count} x ${s(d.reason)}`),
    ...r.fidelity.missingInstances.map((m) => `instance ${s(m.instance)}: ${m.kind} in ${m.hours.map(s).join(', ') || 'unknown hours'}`),
  ]);
  section(
    'Rerouted requests',
    r.rerouted.map((x) => `${x.count} x from ${s(x.fromRoute)} to ${s(x.toRoute)}, request class ${s(x.requestClass)}`),
  );
  section(
    'Blocked requests',
    r.blocked.map((b) => `${b.policy}: ${b.count} x ${b.reason}${b.name === '' ? '' : ` ${s(b.name)}`}`),
  );
  section(
    'Cut sessions',
    r.cutSessions.map(
      (c) =>
        `${c.policy}: session ${s(c.session)} (team ${s(c.team)}, repo ${s(c.repo)}, request class ${s(c.requestClass)}) cut at request ${c.requestIndex} by ${s(c.cause)}; ${c.droppedRequests} later requests (${formatUsd(c.droppedCostMicroUsd)}) would not have run as recorded`,
    ),
  );
  section(
    'Budget hits',
    r.budgetHits.map((h) => `${h.policy}: ${s(h.budget)} ${s(h.scopeValue)}, first hit ${h.firstHitTs}, on ${h.days} day${h.days === 1 ? '' : 's'}`),
  );
  section(
    'How exact is this',
    r.exactness.map((e) => `[${e.applied ? 'x' : ' '}] ${e.output}: ${EXACTNESS_LABEL[e.exactness]}`),
  );
  out.push('', r.gates.failed.length === 0 ? 'Check: passed.' : `Check: failed (${r.gates.failed.map(s).join(', ')}).`);
  return `${out.join('\n')}\n`;
}
