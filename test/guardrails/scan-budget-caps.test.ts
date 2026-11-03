// The scan budget caps (S-V3-1, S-V3-3) at their boundary, with the values written out. Stryker ignores static mutants
// (stryker.config.mjs), so a changed cap constant is not caught there; these cases fail on any change of a cap or of
// the comparison at it: the cap's worth of work passes, one more unit is refused.
import { expect, test } from 'vitest';
import { countEscapesUpTo, SCAN_ESCAPE_BUDGET, SCAN_MATCH_BUDGET, SCAN_RUN_BUDGET, ScanBudget, ScanBudgetError } from '../../src/guardrails/scan.js';

const RUNS = 3_145_728; // 3 Mi decoded runs per scan call
const MATCHES = 65_536; // 64 Ki regex matches per scan call
const ESCAPES = 1_048_576; // 1 Mi JSON escapes per body

const refusal = (fn: () => void): ScanBudgetError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ScanBudgetError);
    return e as ScanBudgetError;
  }
  throw new Error('expected a ScanBudgetError');
};

test('the caps have their documented values', () => {
  expect([SCAN_RUN_BUDGET, SCAN_MATCH_BUDGET, SCAN_ESCAPE_BUDGET]).toEqual([RUNS, MATCHES, ESCAPES]);
  const b = new ScanBudget();
  expect([b.runLimit, b.matchLimit]).toEqual([RUNS, MATCHES]);
});

test('a default scan budget takes exactly the run cap: the last run within it passes, one more is refused', () => {
  const b = new ScanBudget();
  for (let i = 0; i < RUNS - 1; i++) b.run();
  expect(() => b.run()).not.toThrow();
  expect(b.used().runs).toBe(RUNS);
  const e = refusal(() => b.run());
  expect([e.counter, e.limit]).toEqual(['runs', RUNS]);
  // Matches have their own count: runs at the cap leave all of them.
  expect(b.used().matches).toBe(0);
});

test('a default scan budget takes exactly the match cap: the last match within it passes, one more is refused', () => {
  const b = new ScanBudget();
  for (let i = 0; i < MATCHES - 1; i++) b.match();
  expect(() => b.match()).not.toThrow();
  expect(b.used().matches).toBe(MATCHES);
  const e = refusal(() => b.match());
  expect([e.counter, e.limit]).toEqual(['matches', MATCHES]);
  expect(b.used().runs).toBe(0);
});

test('the escape cap: a body with exactly the cap of escapes is not over it, one more escape is (the handler check)', () => {
  // src/edge/handler.ts refuses when countEscapesUpTo(body, whole, SCAN_ESCAPE_BUDGET) > SCAN_ESCAPE_BUDGET.
  const over = (n: number): boolean => {
    const body = Buffer.from(`"${'\\n'.repeat(n)}"`);
    return countEscapesUpTo(body, { start: 0, end: body.length }, SCAN_ESCAPE_BUDGET) > SCAN_ESCAPE_BUDGET;
  };
  expect(over(ESCAPES - 1)).toBe(false);
  expect(over(ESCAPES)).toBe(false);
  expect(over(ESCAPES + 1)).toBe(true);
});
