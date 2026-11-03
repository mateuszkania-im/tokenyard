// No rule may backtrack super-linearly: every rule, secret and PII, runs over crafted 1 MiB bodies built from its own
// keywords and near-misses. Locally (Apple silicon, Node 22) most bodies take tens of milliseconds and the worst, a body
// made only of escapes, about 300 ms (decoding dominates). The old jwt rule took 5.7 s on 128 KiB of `eyJ-` and grew
// with the square of the size, so a quadratic rule on 1 MiB takes minutes. The bound is 1 s per body: about 3 times the
// local worst case and well over 10 times the typical one, room for a slower CI runner, still far below any quadratic.
import { expect, test } from 'vitest';
import { PII_RULES } from '../../src/guardrails/pii.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans, ScanBudget, scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';

const MIB = 1024 * 1024;
const BOUND_MS = 1_000;
/** No work budget (S-V3-3): a budget stop would hide a slow rule; this test is about the rules, the budget has its own. */
const unbounded = (): ScanBudget => new ScanBudget(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
const fill = (unit: string): string => unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB);

/** Adversarial texts: each keyword repeated with separators the rules accept or reject, long runs, and the classic cases. */
function adversarial(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const keywords = new Set(DEFAULT_RULES.flatMap((r) => r.keywords));
  for (const k of keywords) {
    out.push([`${k} repeated with -`, fill(`${k}-`)]);
    out.push([`${k} repeated with A run`, fill(`${k}${'A'.repeat(30)}.`)]);
    out.push([`${k} then one long run`, `${k}${'aB3_'.repeat(MIB / 4)}`]);
    out.push([`${k} repeated`, fill(k)]);
  }
  out.push(['jwt eyJ-', fill('eyJ-')]);
  out.push(['jwt near miss', fill(`eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.`)]);
  out.push(['private key without END', fill(`-----BEGIN PRIVATE KEY-----${'A'.repeat(70_000)}`)]);
  out.push(['email a@', fill('a@')]);
  out.push(['email labels', `a@${'b.'.repeat(MIB / 2)}`]);
  out.push(['email local part', fill('a.b+c%d-e_')]);
  out.push(['digits', fill('1')]);
  out.push(['digits and spaces', fill('1 ')]);
  out.push(['digits and dashes', fill('4-')]);
  out.push(['iban-like', fill('PL61 1090 ')]);
  out.push(['generic token=', fill('token=')]);
  out.push(['generic secrets', fill('secret_')]);
  out.push(['escapes', fill('\n\t\\/"')]);
  return out;
}

/** Bodies outside the string view: one huge bare token, many small bare tokens, malformed bodies scanned raw and decoded. */
function adversarialBodies(): Array<[string, Buffer, boolean]> {
  return [
    ['bare token run', Buffer.from(`{"messages":[{"role":"user","content":[${fill('eyJ-')}]}]}`), false],
    ['many bare tokens', Buffer.from(`{"messages":[{"role":"user","content":[${fill('AKIA1,')}0]}]}`), false],
    ['raw malformed', Buffer.from(`{"messages":[{"role":"user","content":"${fill('a@b.')}`), true],
    // Many distinct hits in both the raw view and its decoded copy: merging them must stay linear.
    ['raw malformed, many hits', Buffer.from(`{"messages":[{"role":"user","content":"${Array.from({ length: 60_000 }, (_, i) => `u${i}@example.com`).join(' ')}`), true],
  ];
}

test('every rule scans adversarial 1 MiB bodies within the time bound (no super-linear backtracking)', () => {
  const rules = [...DEFAULT_RULES, ...PII_RULES];
  const slow: string[] = [];
  let worst = 0;
  for (const [name, text] of adversarial()) {
    const b = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: text }] }));
    const f = extractAnthropicFeatures(b);
    const t0 = performance.now();
    scanBody(b, f.lastTurn, rules, () => 'block', 's', { messages: f.messages, budget: unbounded() });
    findSpans(b, rules, { messages: f.messages, budget: unbounded() });
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms);
    if (ms > BOUND_MS) slow.push(`${name}: ${ms.toFixed(0)} ms`);
  }
  for (const [name, b, raw] of adversarialBodies()) {
    const t0 = performance.now();
    scanBody(b, { start: 0, end: b.length }, rules, () => 'block', 's', { raw, budget: unbounded() });
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms);
    if (ms > BOUND_MS) slow.push(`${name}: ${ms.toFixed(0)} ms`);
  }
  console.log(`redos: worst ${worst.toFixed(0)} ms per 1 MiB body`);
  expect(slow).toEqual([]);
}, 120_000);
