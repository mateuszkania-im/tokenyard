// Spec 9.4: the sticky PR comment. Snapshot on the committed demo traces, fidelity above the table, hostile labels.
import { join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { loadReplayPolicy, openReplayTraces } from '../../src/policy-loader/replay-input.js';
import { replay, type ReplayResult } from '../../src/replay/engine.js';
import { renderMarkdown } from '../../src/replay/render-markdown.js';

const ROOT = join(import.meta.dirname, '..', '..');
const O = { baseRev: 'a1b2c3d', headRev: 'e4f5a6b', checkSummary: { errors: 0, warnings: 1 } };

let demo: ReplayResult;
beforeAll(async () => {
  const base = await loadReplayPolicy({ source: join(ROOT, 'examples/policy'), headDir: join(ROOT, 'examples/policy'), experimentalSubscription: false });
  const head = await loadReplayPolicy({ source: join(ROOT, 'examples/policy-head'), headDir: join(ROOT, 'examples/policy-head'), experimentalSubscription: false });
  demo = await replay({ base, head, traces: await openReplayTraces([join(ROOT, 'examples/traces/demo.ndjson.gz')]), sinceMs: null, tenant: null });
});

test('markdown matches spec 9.4 layout and starts with the sticky marker', () => {
  const md = renderMarkdown(demo, O);
  expect(md.startsWith('<!-- tokenyard-replay -->\n### tokenyard policy replay: ')).toBe(true);
  for (const h of ['| | Base | Head | Change |', '| Cost (billed)', '| Requests rerouted', '| Requests blocked', '| Sessions cut mid-task', '| Budget hits', '<details><summary>How exact is this</summary>', 'Check: ']) expect(md).toContain(h);
  expect(md).toBe(renderMarkdown(demo, O));
  expect(md).toMatchSnapshot();
});

test('fidelity line and missing instances appear above the table', () => {
  const r: ReplayResult = {
    ...demo,
    fidelity: { agreement: 0.9, disagreements: [{ reason: 'recorded forward, replayed block (budget)', count: 3 }], missingInstances: [{ instance: 'gw-2', hours: ['2026-11-02T10'], kind: 'no-file' }] },
  };
  const md = renderMarkdown(r, O);
  const table = md.indexOf('| | Base | Head | Change |');
  expect(md.indexOf('Fidelity: base replay matches recorded decisions on 90.0% of requests')).toBeGreaterThan(-1);
  expect(md.indexOf('Fidelity: ')).toBeLessThan(table);
  expect(md.indexOf('gw-2')).toBeGreaterThan(-1);
  expect(md.indexOf('gw-2')).toBeLessThan(table);
  expect(md.indexOf('Do not trust')).toBeLessThan(table);
});

test('hostile labels cannot add a column, a link, a tag or a mention', () => {
  const evil = ['\u001b[31mred\u001b[0m', '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007', 'a\nb|c', '`tick`', 'x | y | z', '<script>alert(1)</script>', '[x](javascript:alert(1))', '@everyone ![i](http://e/x.png)'];
  const lab = (i: number): string => evil[i % evil.length] ?? '';
  const r: ReplayResult = {
    ...demo,
    tenant: lab(2),
    rerouted: evil.map((e, i) => ({ fromRoute: e, toRoute: lab(i + 3), requestClass: lab(i + 1), count: 2 })),
    blocked: evil.map((e) => ({ policy: 'head' as const, reason: 'budget' as const, name: e, count: 1 })),
    cutSessions: evil.map((e, i) => ({ policy: 'head' as const, session: e, team: lab(i + 1), repo: lab(i + 2), requestClass: lab(i + 3), requestIndex: 1, cause: e, droppedRequests: 1, droppedCostMicroUsd: 5 })),
    budgetHits: evil.map((e, i) => ({ policy: 'head' as const, budget: e, scopeValue: lab(i + 1), firstHitTs: '2026-11-02T10:00:00.000Z', days: 1 })),
    gates: { failed: evil },
    fidelity: { agreement: 1, disagreements: evil.map((reason) => ({ reason, count: 1 })), missingInstances: evil.map((instance) => ({ instance, hours: [lab(1)], kind: 'no-file' as const })) },
  };
  const md = renderMarkdown(r, { baseRev: evil[3] ?? '', headRev: evil[5] ?? '', checkSummary: { errors: 0, warnings: 0 } });
  expect([...md].some((c) => c.charCodeAt(0) === 0x1b || c.charCodeAt(0) === 7)).toBe(false);
  expect(md).not.toContain('<script');
  expect(md).not.toMatch(/<(?!\/?(details|summary)\b|!--)/);
  const dynamic = md.split('<details><summary>How exact')[0] ?? '';
  expect(dynamic).not.toMatch(/\]\(/);
  expect(md).not.toContain('@everyone');
  expect(dynamic).not.toMatch(/\[[^\]]*\]/);
  // the summary table keeps its four columns on every row
  for (const line of md.split('\n').filter((l) => l.startsWith('|'))) {
    const cols = line.replace(/&#124;/g, '').split('|').length - 2;
    expect([4, 3, 2]).toContain(cols);
  }
  const summary = md.split('\n').filter((l) => /^\| (\| |Cost \(|Requests (rerouted|blocked)|Sessions cut|Budget hits \|)/.test(l));
  expect(summary.length).toBeGreaterThanOrEqual(6);
  for (const l of summary) expect([l, l.split('|').length - 2]).toEqual([l, 4]);
  // the line count of the comment does not depend on newlines inside labels
  expect(md.split('\n').some((l) => l === 'b')).toBe(false);
});

test('escapeMarkdown stops mentions, issue links, autolinks, math and backslash escapes that GitHub still renders from entities', async () => {
  const { escapeMarkdown } = await import('../../src/report/sanitize.js');
  const zw = '​';
  expect(escapeMarkdown('@octocat')).toBe(`@${zw}octocat`);
  expect(escapeMarkdown('@org/team')).toBe(`@${zw}org/team`);
  expect(escapeMarkdown('#1')).toBe(`#${zw}1`);
  const link = escapeMarkdown('https://evil.example/x and www.evil.example');
  expect(link).not.toContain('https://');
  expect(link).not.toContain('www.');
  expect(link).not.toContain(':');
  expect(link).not.toContain('.');
  expect(escapeMarkdown('$x$ and $$y$$')).not.toContain('$');
  expect(escapeMarkdown('a\\|b')).not.toContain('\\');
  expect(escapeMarkdown('a\\|b')).not.toContain('|');
  // none of the entities or marks written above starts a mention or issue reference again
  const all = escapeMarkdown('@a #b [c](d) <e> `f` *g* _h_ ~i~ j|k');
  expect(all).not.toMatch(/(?<!&)[@#][A-Za-z0-9]/);
  expect(all).not.toMatch(/[<>|`*_~[\]]/);
});
