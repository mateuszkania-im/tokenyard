// S7b (coordinator finding, Task 7, MEDIUM): report renderers printed client-header attribution verbatim: terminal
// escape sequences, Markdown (PR comment) and HTML injection. Labels are stripped of controls at ingest and escaped
// in every renderer. One hostile label list goes through the terminal, Markdown and HTML renderers here.
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { loadReplayPolicy, openReplayTraces } from '../../src/policy-loader/replay-input.js';
import { replay } from '../../src/replay/engine.js';
import { renderMarkdown } from '../../src/replay/render-markdown.js';
import { renderReportHtml } from '../../src/report/render-html.js';
import { renderReportTerminal } from '../../src/report/render-terminal.js';
import { buildReport } from '../../src/report/report.js';
import { baseRecord } from '../helpers/trace.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const HOSTILE = [`${ESC}[2J${ESC}[31mred${ESC}[0m`, `${ESC}]8;;https://evil.example${BEL}click${ESC}]8;;${BEL}`, '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '[x](javascript:alert(1)) @everyone'];

function rec(i: number, label: string): TraceRecord {
  const b = baseRecord({ id: String(i), team: label });
  b.attribution = { ...b.attribution, requestClass: 'main', feature: label };
  b.outcome = { ...b.outcome, costMicroUsd: 1 };
  return { ...b, instance: 'i', seq: 1 };
}
const report = () => buildReport(HOSTILE.map((l, i) => rec(i, l)), ['team']);
const hasControl = (s: string): boolean => [...s].some((c) => { const n = c.charCodeAt(0); return (n < 0x20 && n !== 10) || (n >= 0x7f && n <= 0x9f); });

test('S7b the terminal report carries no escape sequence from a client header', () => {
  const text = renderReportTerminal(report());
  expect(hasControl(text)).toBe(false);
  expect(text).not.toContain(ESC);
});

test('S7b the HTML report carries no tag, attribute or control character from a client header', () => {
  const html = renderReportHtml(report());
  const body = html.slice(html.indexOf('<body'));
  expect(body).not.toMatch(/<script|<img/i);
  expect(body).toContain('&lt;script&gt;');
  expect(hasControl(html)).toBe(false);
});

test('S7b the Markdown PR comment gets no link, mention, tag or control character from a client header', async () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  const [base, head] = await Promise.all(['examples/policy', 'examples/policy-head'].map((d) => loadReplayPolicy({ source: join(ROOT, d), headDir: join(ROOT, d), experimentalSubscription: false })));
  const demo = await replay({ base: base!, head: head!, traces: await openReplayTraces([join(ROOT, 'examples/traces/demo.ndjson.gz')]), sinceMs: null, tenant: null });
  const lab = (i: number): string => HOSTILE[i % HOSTILE.length] ?? '';
  const r = {
    ...demo,
    rerouted: HOSTILE.map((e, i) => ({ fromRoute: e, toRoute: lab(i + 1), requestClass: lab(i + 2), count: 1 })),
    blocked: HOSTILE.map((e) => ({ policy: 'head' as const, reason: 'budget' as const, name: e, count: 1 })),
  };
  const md = renderMarkdown(r, { baseRev: lab(1), headRev: lab(2), checkSummary: { errors: 0, warnings: 0 } });
  expect(hasControl(md)).toBe(false);
  expect(md).not.toContain('<script');
  expect(md).not.toContain('@everyone');
  expect(md.split('<details><summary>How exact')[0] ?? '').not.toMatch(/\]\(/);
});
