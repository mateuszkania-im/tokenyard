// Self-contained HTML cost report (spec 13): one file, inline CSS only, no script, no font, no image, nothing fetched from
// the network. Light and dark come from prefers-color-scheme. Every label is escaped for HTML text; the CSP meta tag
// forbids scripts and remote loads even if an escape were ever missed.
import { formatUsd } from './render-terminal.js';
import type { Report, ReportRow } from './report.js';
import { stripControls } from './sanitize.js';

const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML text and attribute-safe form of a label: control characters dropped, &, <, >, " and ' as character references. */
export function escapeHtml(s: string): string {
  return stripControls(s).replace(/[&<>"']/g, (c) => ENTITY[c] ?? c);
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#5b6570;--line:#d8dde3;--bar:#2f6fed;--head:#f3f5f8}
@media (prefers-color-scheme: dark){:root{--bg:#14171b;--fg:#e6e9ed;--muted:#97a1ad;--line:#2d333b;--bar:#6c9bff;--head:#1c2026}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
p{margin:0 0 16px;color:var(--muted)}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{background:var(--head);font-weight:600}
td.n,th.n{text-align:right}
tfoot td{font-weight:600;border-top:2px solid var(--line)}
.bar{display:inline-block;height:8px;border-radius:4px;background:var(--bar);vertical-align:middle;margin-left:8px}`;

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);
const num = (n: number): string => String(n);

export function renderReportHtml(r: Report): string {
  const cols = r.by.length > 0 ? r.by.map(String) : ['all'];
  const cost = (x: ReportRow): string => formatUsd(x.costMicroUsd) + (x.unpriced > 0 ? `+${x.unpriced} unpriced` : '');
  const share = (x: ReportRow): string => {
    const p = pct(x.costMicroUsd, r.totals.costMicroUsd);
    return `${r.totals.costMicroUsd === 0 ? '-' : `${p.toFixed(1)}%`}<span class="bar" style="width:${Math.round(p)}px"></span>`;
  };
  const numeric = (x: ReportRow, bar: boolean): string =>
    [num(x.requests), cost(x), bar ? share(x) : '', num(x.input), num(x.output), num(x.cacheRead), num(x.cacheWrite)].map((c) => `<td class="n">${c}</td>`).join('');
  const head = [...cols.map((c) => `<th>${escapeHtml(c)}</th>`), ...['requests', 'cost', 'share', 'input', 'output', 'cache read', 'cache write'].map((c) => `<th class="n">${c}</th>`)].join('');
  const rows = r.groups
    .map((g) => `<tr>${(r.by.length > 0 ? r.by.map((d) => g.key[d] ?? '') : ['all']).map((l) => `<td>${escapeHtml(l)}</td>`).join('')}${numeric(g, true)}</tr>`)
    .join('\n');
  const total = `<tr><td>total</td>${cols.slice(1).map(() => '<td></td>').join('')}${numeric(r.totals, false)}</tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tokenyard cost report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>tokenyard cost report</h1>
<p>${r.totals.requests} requests grouped by ${escapeHtml(cols.join(', '))}. Costs are priced at the recorded prices; unpriced requests count as zero.</p>
<div class="wrap">
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
<tfoot>${total}</tfoot>
</table>
</div>
</main>
</body>
</html>
`;
}
