import { expect, test } from 'vitest';
import { topSelf } from '../../scripts/cpuprofile-top.mjs';

test('cpuprofile-top sums self time per function from samples and time deltas, largest first (V1)', () => {
  const frame = (id: number, functionName: string, url: string, lineNumber = 0) => ({ id, callFrame: { functionName, url, lineNumber, columnNumber: 0, scriptId: '1' } });
  const profile = {
    nodes: [frame(1, '(root)', ''), frame(2, 'scan', 'file:///repo/src/guardrails/scan.ts', 9), frame(3, '', 'file:///repo/node_modules/x/index.js', 0), frame(4, '(idle)', '')],
    samples: [2, 2, 3, 4, 2],
    timeDeltas: [0, 1000, 1000, 1000, 1000],
  };
  const t = topSelf(profile, 10, '/repo');
  expect(t.totalMs).toBe(4);
  expect(t.rows).toEqual([
    { fn: 'scan src/guardrails/scan.ts:10', ms: 2, pct: 50 },
    { fn: '(anonymous) node_modules/x/index.js:1', ms: 1, pct: 25 },
    { fn: '(idle) ', ms: 1, pct: 25 },
  ]);
});
