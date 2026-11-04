import { expect, test } from 'vitest';
import { buildReport } from '../../src/report/report.js';
import { renderReportHtml } from '../../src/report/render-html.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { baseRecord } from '../helpers/trace.js';

function rec(id: string, team: string | null, cost: number | null): TraceRecord {
  const b = baseRecord({ id, team });
  b.outcome = { ...b.outcome, costMicroUsd: cost };
  return { ...b, instance: 'i', seq: 1 };
}

test('html report is one file with no external requests and contains every team row', () => {
  const teams = ['platform', 'web', 'data', 'mobile'];
  const records = teams.map((t, i) => rec(String(i), t, (i + 1) * 1_000_000));
  const html = renderReportHtml(buildReport(records, ['team']));
  expect(html.startsWith('<!doctype html>')).toBe(true);
  for (const t of teams) expect(html).toContain(`<td>${t}</td>`);
  expect(html).toContain('$10.0000'); // total
  // Self-contained: nothing loads from the network, no script, no linked stylesheet, no image, no font.
  expect(html).not.toMatch(/https?:|\/\/|<script|<link|<img|<iframe|<object|@import|url\(|src=|href=/i);
  expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  expect(html).toContain('prefers-color-scheme: dark');
});

test('html report neutralises hostile labels: no tag, attribute, quote or control character survives', () => {
  const nasty = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    '</style><script>x</script>',
    `it's "quoted" & <b>`,
    'a\u001b[31mb\u0007c\u0085d\nline',
  ];
  const html = renderReportHtml(buildReport(nasty.map((n, i) => rec(String(i), n, 1)), ['team']));
  const body = html.slice(html.indexOf('<body'));
  expect(body).not.toMatch(/<script|<img|<b>|<\/style/i);
  expect(html.match(/<style>/g)?.length).toBe(1);
  expect(html.match(/<\/style>/g)?.length).toBe(1);
  expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(body).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  expect(body).toContain('it&#39;s &quot;quoted&quot; &amp; &lt;b&gt;');
  expect([...html].some((c) => (c.charCodeAt(0) < 0x20 && c !== '\n') || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f))).toBe(false);
  expect(html).toContain('a[31mbcdline'); // controls dropped, label text kept
});

test('html report of an empty window still renders a total row', () => {
  const html = renderReportHtml(buildReport([], ['team', 'repo']));
  expect(html).toContain('<td>total</td>');
  expect(html).toContain('$0.0000');
});
