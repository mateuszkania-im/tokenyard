// Minimal cost report over trace records (spec 9.1 fields): pure, no I/O.
import type { TraceRecord } from '../ledger/record.js';

export const REPORT_DIMENSIONS = ['tenant', 'team', 'key', 'repo', 'branch', 'ticket', 'session', 'requestClass', 'agent', 'promptId'] as const;
export type ReportDimension = (typeof REPORT_DIMENSIONS)[number];

export interface ReportRow {
  requests: number;
  costMicroUsd: number;
  /** Requests with no cost (no usage or an unpriced model); they count as zero in `costMicroUsd`. */
  unpriced: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface ReportGroup extends ReportRow {
  key: Partial<Record<ReportDimension, string>>;
}
export interface Report {
  by: ReportDimension[];
  totals: ReportRow;
  groups: ReportGroup[];
}

export const NONE = '(none)';

function dimension(r: TraceRecord, d: ReportDimension): string | null {
  switch (d) {
    case 'tenant': return r.tenant;
    case 'team': return r.team;
    case 'key': return r.keyId;
    case 'repo': return r.attribution.repo;
    case 'branch': return r.attribution.branch;
    case 'ticket': return r.attribution.ticket;
    case 'session': return r.attribution.session;
    case 'requestClass': return r.attribution.requestClass;
    case 'agent': return r.attribution.agent;
    case 'promptId': return r.attribution.promptId;
  }
}

const empty = (): ReportRow => ({ requests: 0, costMicroUsd: 0, unpriced: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function add(row: ReportRow, r: TraceRecord): void {
  const u = r.outcome.usage;
  row.requests++;
  if (r.outcome.costMicroUsd === null) row.unpriced++;
  else row.costMicroUsd += r.outcome.costMicroUsd;
  if (u) {
    row.input += u.input;
    row.output += u.output;
    row.cacheRead += u.cacheRead;
    row.cacheWrite += u.cacheWrite5m + u.cacheWrite1h;
  }
}

/** Groups by the given dimensions (empty `by` gives one group), most expensive first; the totals are the sum of all records. */
export function buildReport(records: TraceRecord[], by: ReportDimension[]): Report {
  const totals = empty();
  const groups = new Map<string, ReportGroup>();
  for (const r of records) {
    add(totals, r);
    const key: ReportGroup['key'] = {};
    for (const d of by) key[d] = dimension(r, d) ?? NONE;
    const id = JSON.stringify(by.map((d) => key[d]));
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { ...empty(), key }));
    add(g, r);
  }
  const sorted = [...groups.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.requests - a.requests || idOf(a, by).localeCompare(idOf(b, by)));
  return { by, totals, groups: sorted };
}

const idOf = (g: ReportGroup, by: ReportDimension[]): string => by.map((d) => g.key[d]).join('\u0000');
