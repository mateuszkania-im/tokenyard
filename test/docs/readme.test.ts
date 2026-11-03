// Spec 13 and the global constraints: the README and docs say only what was measured, carry the replay exactness
// table verbatim, never mention subscription passthrough, use no em dashes or arrows in prose, and the live examples
// hold nothing that identifies the raw live traces.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { EXACTNESS_TABLE } from '../../src/replay/diff.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const readme = read('README.md');
const LIVE_DIR = 'examples/live';

/** Prose only: fenced code, inline code and HTML comments dropped (commands and markers may hold `->` or `=>`). */
function proseOnly(md: string): string {
  return md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** README, changelog and every Markdown file under docs/ except implementation plans (code-heavy working notes). */
function docFiles(): string[] {
  const out = ['README.md', 'CHANGELOG.md'];
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (p !== 'docs/superpowers/plans') walk(p);
      } else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk('docs');
  return out.filter((f) => existsSync(join(ROOT, f)));
}
const all = docFiles()
  .map((f) => read(f))
  .join('\n');

/** A `## Heading` section of the README up to the next `## ` heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`README has no "## ${heading}" section`);
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next < 0 ? undefined : next);
}

/**
 * Hand-written text of a section with its numbers: the generated BENCH block is left out (bench:check compares it with
 * bench/results.json byte for byte), as are code, link targets, HTML tags and identifiers that contain digits
 * (R11, p99, claude-opus-5-5, web_search_20250305).
 */
function handWritten(md: string): string {
  return proseOnly(md.replace(/<!-- BENCH:START -->[\s\S]*?<!-- BENCH:END -->/, ''))
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b[A-Za-z_][\w.-]*\d[\w.-]*/g, ' ');
}

const DATE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?\b/g;
const VERSION = /\b\d+\.\d+\.\d+\b/g;
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Every number in a JSON value: numbers, and numbers written inside strings. */
function numbersIn(v: unknown, out: number[]): void {
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'string') for (const m of v.match(NUMBER) ?? []) out.push(Number(m.replaceAll(',', '')));
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) numbersIn(x, out);
}

/** Text of every file in examples/live (gzip inflated, images skipped). */
function liveTexts(): Array<{ file: string; text: string }> {
  const dir = join(ROOT, LIVE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !/\.(png|gif|jpe?g)$/.test(f))
    .map((f) => {
      const buf = readFileSync(join(dir, f));
      return { file: f, text: (f.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8') };
    });
}

function liveRecords(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const t of liveTexts()) {
    if (!/\.ndjson(\.gz)?$/.test(t.file)) continue;
    for (const line of t.text.split('\n')) if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
  }
  return out;
}

test('README exactness table equals the replay constant verbatim', () => {
  expect(readme).toContain(`\n${EXACTNESS_TABLE}\n`);
});

test('README has no subscription passthrough mention', () => expect(readme).not.toMatch(/experimental-subscription|subscription (mode|passthrough|login)|OAuth/i));

test('README and docs contain no em dash and no arrow characters', () => expect(proseOnly(all)).not.toMatch(/[—→⇒]|->|=>/));

test('every number in the README Measured and Real sessions sections appears in bench/results.json or examples/live', () => {
  const sources = [read('bench/results.json'), ...liveTexts().map((t) => t.text)];
  const haystack: number[] = [];
  for (const s of sources) {
    try {
      numbersIn(JSON.parse(s), haystack);
    } catch {
      // HTML report or NDJSON: every number written in it.
      numbersIn(s, haystack);
    }
  }
  const values = [...new Set(haystack)];
  const text = sources.join('\n');
  const missing: string[] = [];
  for (const name of ['Measured', 'Real sessions', 'Budgets']) {
    let prose = handWritten(section(readme, name));
    // Dates and versions must appear as written.
    for (const re of [DATE, VERSION]) {
      for (const m of prose.match(re) ?? []) if (!text.includes(m)) missing.push(`${name}: ${m}`);
      prose = prose.replace(re, ' ');
    }
    // A number matches a source value that rounds to it at the precision shown (or its percentage, before a %).
    for (const m of prose.matchAll(NUMBER)) {
      const shown = m[0].replaceAll(',', '');
      const x = Number(shown);
      const decimals = shown.includes('.') ? (shown.split('.')[1] ?? '').length : 0;
      const tol = 0.5 * 10 ** -decimals + 1e-9;
      const percent = prose[(m.index ?? 0) + m[0].length] === '%';
      const ok = values.some((v) => Math.abs(v - x) <= tol || (percent && Math.abs(v * 100 - x) <= tol));
      if (!ok) missing.push(`${name}: ${m[0]}`);
    }
  }
  expect(missing).toEqual([]);
});

test('examples/live holds no prompt text, raw session ids, file paths or key-shaped strings', () => {
  const texts = liveTexts();
  expect(texts.length).toBeGreaterThan(0);
  const shapes = [
    /\bsk-[A-Za-z0-9_-]{8,}/, // provider keys
    /\bty_live_[A-Za-z0-9]{8,}/, // tokenyard keys
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS key ids
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // raw (UUID) session ids
    /(?:^|["'\s(])(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Z]:\\)/, // file paths
    /"(?:content|text|prompt|instructions|input)"\s*:\s*"/, // prompt text fields
  ];
  const hits = texts.flatMap((t) => shapes.filter((re) => re.test(t.text)).map((re) => `${t.file}: ${String(re)}`));
  expect(hits).toEqual([]);
  for (const r of liveRecords().filter((x) => x.kind === 'request')) expect((r.client as { version: unknown }).version).toBeNull();
});

// The list of raw names is generated locally from .live/traces (gitignored) by `npx tsx bench/live-summary.ts`, so this
// test runs only on the machine that holds the raw live traces, never in CI.
const RAW_NAMES = join(ROOT, '.live', 'raw-names.json');
describe.skipIf(Boolean(process.env.CI) || !existsSync(RAW_NAMES))('raw live names (local only)', () => {
  test('examples/live contains no repo, branch, ticket or tenant names from the raw live traces', () => {
    const raw = JSON.parse(readFileSync(RAW_NAMES, 'utf8')) as { names: Array<{ kind: string; value: string }> };
    expect(raw.names.length).toBeGreaterThan(0);
    const values = new Set(raw.names.map((n) => n.value));
    // Every identifying field of every exported record is a pseudonym, never a raw value.
    for (const r of liveRecords().filter((x) => x.kind === 'request')) {
      const a = r.attribution as Record<string, unknown>;
      for (const v of [r.tenant, r.team, r.keyId, a.repo, a.branch, a.ticket, a.feature]) {
        if (typeof v === 'string') expect(values.has(v), 'a raw name in an identifying field').toBe(false);
      }
    }
    // No raw name anywhere in the text, as a whole word. A name the repository already publishes (the live policy's
    // tenant and team are named in test/live/policy.yaml) is checked by the field test above only, since the same
    // word is also the live policy's revision.
    const published = read('test/live/policy.yaml');
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leaks: string[] = [];
    for (const t of liveTexts()) {
      for (const n of raw.names) {
        if (new RegExp(`(?<![\\w-])${esc(n.value)}(?![\\w-])`).test(published)) continue;
        if (new RegExp(`(?<![\\w-])${esc(n.value)}(?![\\w-])`, 'i').test(t.text)) leaks.push(`${t.file}: a ${n.kind} name`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test('examples/live contains no record, instance, session, agent or prompt id, prefix hash or guardrail HMAC from the raw live traces', () => {
    const raw = JSON.parse(readFileSync(RAW_NAMES, 'utf8')) as { ids?: string[] };
    expect(raw.ids?.length ?? 0).toBeGreaterThan(0);
    const found = liveTexts().flatMap((t) => (raw.ids ?? []).filter((id) => t.text.includes(id)).map(() => t.file));
    // Counts per file only: the ids themselves are never printed.
    expect(found.length).toBe(0);
  });
});
