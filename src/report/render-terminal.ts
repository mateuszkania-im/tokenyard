import type { Report, ReportRow } from './report.js';

/** Integer micro-USD as dollars with four decimals, without floats. */
export function formatUsd(micro: number): string {
  const cents = Math.round(micro / 100); // hundredths of a cent
  return `$${Math.floor(cents / 10_000)}.${String(cents % 10_000).padStart(4, '0')}`;
}

const pct = (part: number, whole: number): string => (whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`);

/** Plain-text table, no colour, so it pipes and pastes cleanly. */
export function renderReportTerminal(r: Report): string {
  const cols = r.by.length > 0 ? r.by.map(String) : ['all'];
  const header = [...cols, 'requests', 'cost', 'share', 'input', 'output', 'cache read', 'cache write'];
  const row = (label: string[], x: ReportRow): string[] => [
    ...label,
    String(x.requests),
    formatUsd(x.costMicroUsd) + (x.unpriced > 0 ? `+${x.unpriced} unpriced` : ''),
    pct(x.costMicroUsd, r.totals.costMicroUsd),
    String(x.input),
    String(x.output),
    String(x.cacheRead),
    String(x.cacheWrite),
  ];
  const rows = [
    header,
    ...r.groups.map((g) => row(r.by.length > 0 ? r.by.map((d) => g.key[d] ?? '') : ['all'], g)),
    row(['total', ...cols.slice(1).map(() => '')], r.totals),
  ];
  const widths = header.map((_, i) => Math.max(...rows.map((x) => (x[i] ?? '').length)));
  const numeric = (i: number): boolean => i >= cols.length;
  return (
    rows
      .map((x) => x.map((c, i) => (numeric(i) ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0))).join('  ').trimEnd())
      .join('\n') + '\n'
  );
}
