import { expect, test } from 'vitest';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans } from '../../src/guardrails/scan.js';
import { RULE_FIXTURES } from './fixtures.js';

/** A fixture as it travels: inside a JSON string of a request body. */
const inBody = (v: string): Buffer => Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: `see ${v} here` }] }));

test('the rule list covers spec 6.6, each rule with a source, a licence and a keyword', () => {
  const ids = DEFAULT_RULES.map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(Object.keys(RULE_FIXTURES).sort()).toEqual([...ids].sort());
  for (const r of DEFAULT_RULES) {
    expect(r.source).not.toBe('');
    expect(r.licence).not.toBe('');
    expect(r.keywords.length).toBeGreaterThan(0);
  }
  const prefixes = DEFAULT_RULES.flatMap((r) => r.keywords);
  for (const p of ['AKIA', 'ASIA', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'sk_live_', 'rk_live_', '-----BEGIN', 'eyJ', 'sk-ant-', 'sk-proj-', 'AIza', 'ty_live_']) {
    expect(prefixes).toContain(p);
  }
  expect(DEFAULT_RULES.filter((r) => r.entropyOnly).map((r) => r.id)).toEqual(['generic-secret-assignment']);
});

test.each(DEFAULT_RULES.map((r) => [r.id, r] as const))('rule %s matches its positive fixture and not its negative one', (id, rule) => {
  const f = RULE_FIXTURES[id];
  if (!f) throw new Error(`no fixture for ${id}`);
  const pos = findSpans(inBody(f.positive), [rule]);
  expect(pos).toHaveLength(1);
  // The JSON-escaped form of the fixture contains the matched value (newlines travel as \n).
  expect(JSON.stringify(f.positive)).toContain(pos[0]?.value);
  expect(findSpans(inBody(f.negative), [rule])).toEqual([]);
  // No other rule fires on either fixture, so one secret gives one hit.
  const others = DEFAULT_RULES.filter((r) => r !== rule);
  expect(findSpans(inBody(f.positive), others).map((s) => s.rule.id)).toEqual([]);
});
