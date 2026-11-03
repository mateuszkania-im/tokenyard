// Spec 9.4: the sticky pull request comment. Pure. Every label that comes from a client header, a trace or a policy
// (team, repo, route, budget and rule names, revisions) goes through escapeMarkdown, so a hostile label cannot add a
// table column, a link, a tag or a mention. Dynamic labels are never put in code spans (nothing to break out of).
import { formatUsd } from '../report/render-terminal.js';
import { escapeMarkdown } from '../report/sanitize.js';
import { EXACTNESS_TABLE } from './diff.js';
import type { ReplayResult, Totals } from './engine.js';

export const COMMENT_MARKER = '<!-- tokenyard-replay -->';
const MAX_LIST = 50;

const e = (v: string | null): string => (v === null ? '-' : escapeMarkdown(v));
const n = (x: number): string => x.toLocaleString('en-US');
const pctDown = (x: number): string => `${(Math.floor(x * 1000) / 10).toFixed(1)}%`;
/** A code span only for text that is plain enough to need no escaping (hex revisions, branch-like names); else escaped text. */
const code = (v: string): string => (/^[A-Za-z0-9._/+-]{1,64}$/.test(v) ? `\`${v}\`` : e(v));
const more = (xs: string[]): string[] => (xs.length > MAX_LIST ? [...xs.slice(0, MAX_LIST), `and ${xs.length - MAX_LIST} more`] : xs);
const bullets = (xs: string[]): string => (xs.length === 0 ? 'none' : more(xs).map((x) => `- ${x}`).join('\n'));
const list = (xs: string[], max = 3): string => (xs.length === 0 ? 'none' : xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

function days(r: ReplayResult): string {
  const d = Math.round(((r.window.untilMs - r.window.sinceMs) / 86_400_000) * 10) / 10;
  return `${d} day${d === 1 ? '' : 's'}`;
}

function change(base: Totals, head: Totals): string {
  const d = head.costMicroUsd - base.costMicroUsd;
  const sign = d < 0 ? '-' : '+';
  const rel = base.costMicroUsd === 0 ? '' : ` (${sign}${((Math.abs(d) / base.costMicroUsd) * 100).toFixed(1)}%)`;
  return `**${sign}${formatUsd(Math.abs(d))}${rel}**${base.estimated || head.estimated ? ', estimated (model change)' : ''}`;
}

export function renderMarkdown(r: ReplayResult, o: { baseRev: string; headRev: string; checkSummary: { errors: number; warnings: number }; tracesSha256?: string; tracesSource?: string }): string {
  const basis = r.base.costBasis === r.head.costBasis ? r.base.costBasis : 'mixed';
  const headCuts = r.cutSessions.filter((c) => c.policy === 'head');
  const baseCuts = r.cutSessions.filter((c) => c.policy === 'base');
  const droppedRequests = headCuts.reduce((s, c) => s + c.droppedRequests, 0);
  const droppedCost = headCuts.reduce((s, c) => s + c.droppedCostMicroUsd, 0);
  const rerouted = r.rerouted.reduce((s, x) => s + x.count, 0);
  const classes = [...new Set(r.rerouted.map((x) => x.requestClass ?? 'unclassified'))].sort();
  const targets = [...new Set(r.rerouted.map((x) => x.toRoute))].sort();
  const blockedBy = (p: 'base' | 'head'): string => {
    const by = new Map<string, number>();
    for (const b of r.blocked.filter((x) => x.policy === p)) by.set(b.name === '' ? b.reason : b.name, (by.get(b.name === '' ? b.reason : b.name) ?? 0) + b.count);
    return list([...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, c]) => `${n(c)} ${e(k)}`));
  };
  const blockedN = (p: 'base' | 'head'): number => r.blocked.filter((x) => x.policy === p).reduce((s, x) => s + x.count, 0);
  const hits = (p: 'base' | 'head'): string[] => r.budgetHits.filter((h) => h.policy === p).map((h) => `${e(h.budget)} ${e(h.scopeValue)} on ${h.days} day${h.days === 1 ? '' : 's'}, first hit ${e(h.firstHitTs)}`);
  const headHits = hits('head');
  const untrusted = r.fidelity.disagreements.length > 0 || r.fidelity.missingInstances.length > 0;

  const out: string[] = [COMMENT_MARKER, `### tokenyard policy replay: ${code(o.baseRev)} (base) vs ${code(o.headRev)} (head)`, ''];
  out.push(`Traffic: ${days(r)}, ${n(r.requests)} requests, ${n(r.sessions)} sessions, tenant ${r.tenant === null ? 'all' : code(r.tenant)}. Fidelity: base replay matches recorded decisions on ${pctDown(r.fidelity.agreement)} of requests (details below).`, '');
  if (untrusted) {
    out.push('> **Do not trust the diff below until the fidelity notes are explained.**', '>');
    for (const d of r.fidelity.disagreements) out.push(`> - ${n(d.count)} x ${e(d.reason)}`);
    for (const m of r.fidelity.missingInstances) out.push(`> - instance ${e(m.instance)}: ${m.kind} in ${m.hours.map((h) => e(h)).join(', ') || 'unknown hours'}`);
    out.push('');
  }
  out.push(
    '| | Base | Head | Change |',
    '|---|---|---|---|',
    `| Cost (${basis}) | ${formatUsd(r.base.costMicroUsd)} | ${formatUsd(r.head.costMicroUsd)} | ${change(r.base, r.head)} |`,
    `| Requests rerouted | | ${n(rerouted)} | ${rerouted === 0 ? 'none' : `${classes.map(e).join(' and ')} to ${targets.map(e).join(', ')}`} |`,
    `| Requests blocked | ${n(blockedN('base'))} | ${n(blockedN('head'))} | ${blockedBy('head')} |`,
    `| Sessions cut mid-task | ${n(baseCuts.length)} | ${headCuts.length > 0 ? `**${n(headCuts.length)}**` : '0'} | ${headCuts.length === 0 ? 'none' : `${n(droppedRequests)} later requests (${formatUsd(droppedCost)}) would not have run as recorded`} |`,
    `| Budget hits | ${list(hits('base'))} | ${list(headHits)} | |`,
    '',
  );
  if (r.base.estimated || r.head.estimated) out.push('Cost figures that involve a model change are estimates; see how exact this is below.', '');
  out.push(`<details><summary>Rerouted requests by route and request class</summary>\n\n${bullets(r.rerouted.map((x) => `${n(x.count)} x from ${e(x.fromRoute)} to ${e(x.toRoute)}, request class ${e(x.requestClass)}`))}\n\n</details>`);
  out.push(
    `<details><summary>Blocked requests</summary>\n\n${bullets(r.blocked.map((b) => `${b.policy}: ${n(b.count)} x ${b.reason}${b.name === '' ? '' : ` ${e(b.name)}`}`))}\n\n</details>`,
  );
  out.push(
    `<details><summary>Cut sessions</summary>\n\n${bullets(
      r.cutSessions.map((c) => `${c.policy}: session ${e(c.session)}, team ${e(c.team)}, repo ${e(c.repo)}, request class ${e(c.requestClass)}, request ${c.requestIndex}, cause ${e(c.cause)}; ${n(c.droppedRequests)} later requests (${formatUsd(c.droppedCostMicroUsd)})`),
    )}\n\n</details>`,
  );
  out.push(`<details><summary>Fidelity notes</summary>\n\n${bullets([...r.fidelity.disagreements.map((d) => `${n(d.count)} x ${e(d.reason)}`), ...r.fidelity.missingInstances.map((m) => `instance ${e(m.instance)}: ${m.kind} in ${m.hours.map((h) => e(h)).join(', ') || 'unknown hours'}`)])}\n\n</details>`);
  const rows = EXACTNESS_TABLE.split('\n').slice(2);
  const applied = rows.filter((_, i) => r.exactness[i]?.applied === true);
  out.push(`<details><summary>How exact is this</summary>\n\n| Output | Exactness | Why |\n|---|---|---|\n${applied.length === 0 ? '| none of the rows applied | | |' : applied.join('\n')}\n\n</details>`, '');
  const failed = r.gates.failed;
  if (r.gates.headChangesFailOn) {
    out.push(`This pull request changes ci.failOn; the check uses the stricter of base and head: cutSessions ${r.gates.failOn.cutSessions}, costIncreasePct ${r.gates.failOn.costIncreasePct}.`, '');
  }
  if (o.tracesSha256 !== undefined) out.push(`Traces: ${o.tracesSource === undefined ? '' : `${e(o.tracesSource)}, `}sha256 ${code(o.tracesSha256)}.`, '');
  out.push(`Check: ${failed.length === 0 ? '**passed**' : `**failed** (${failed.map((g) => e(g)).join(', ')})`}. Policy check: ${o.checkSummary.errors} error${o.checkSummary.errors === 1 ? '' : 's'}, ${o.checkSummary.warnings} warning${o.checkSummary.warnings === 1 ? '' : 's'}.`);
  return `${out.join('\n')}\n`;
}
