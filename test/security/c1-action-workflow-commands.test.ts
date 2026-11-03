// C1 (security review C): policy text from a pull request reached the Action's stderr with raw line breaks
// (`error <code> <path>: <message>`, where path and message quote the PR's YAML keys). The runner executes every
// stdout/stderr line that starts with `::`, so a fork PR could emit ::set-output (pointing the always() upload step at
// any runner file), annotations, ::add-mask:: or ::stop-commands::. Every line the Action writes is single-line with
// control characters removed, and the whole run sits between `::stop-commands::<random token>` and `::<token>::`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runAction } from '../../src/action/main.js';
import { actionRepo, fakeGh, HEAD_POLICY, type ActionRepo } from './action-fixture.js';

let r: ActionRepo;
beforeEach(() => {
  r = actionRepo();
});
afterEach(() => r.close());

const EVIL = ['x\\n::set-output name=replay-json::/home/runner/work/_temp\\n::notice title=tokenyard::replay passed', 'y\\r::add-mask::abc\\u2028::error::z', '\\u001b]8;;x\\u0007'];

/** Lines the runner would read as workflow commands: every line of every write that starts with `::`. */
function commandLines(r: ActionRepo): string[] {
  return [...r.stdout, ...r.stderr].flatMap((s) => s.split(/\r\n|\r|\n/)).filter((l) => l.startsWith('::'));
}

/** The stop/resume pair: the first command stops command processing with a random token, the last resumes it. */
function expectOnlyStopPair(r: ActionRepo): void {
  const lines = commandLines(r);
  expect(lines, lines.join('\n')).toHaveLength(2);
  const m = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0] ?? '');
  expect(m, lines[0]).not.toBeNull();
  expect(lines[1]).toBe(`::${m?.[1]}::`);
  expect(r.stdout[0]).toBe(lines[0]);
  expect(r.stdout.at(-1)).toBe(lines[1]);
}

test('C1 policy errors quoting hostile keys never start a workflow command line', async () => {
  const keys = EVIL.map((k, i) => `  "${k}": { format: nope${i}, baseUrl: "https://a.b", credential: { env: X } }\n`).join('');
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY.replace(/^providers:\n/m, `providers:\n${keys}`));
  expect(await runAction(r.env({ fork: true }), fakeGh().gh)).toBe(1);
  expect(r.stderr.some((l) => l.includes('set-output'))).toBe(true);
  const control = (c: number): boolean => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
  for (const l of r.stderr) expect([...l].filter((ch) => control(ch.codePointAt(0) ?? 0))).toEqual([]);
  expectOnlyStopPair(r);
});

test('C1 a hostile YAML error and a thrown error are single lines too', async () => {
  writeFileSync(join(r.repo, 'policy/policy.yaml'), 'a: [\n::error::x\n');
  expect(await runAction(r.env(), fakeGh().gh)).toBe(1);
  expectOnlyStopPair(r);
  r.stdout.length = 0;
  r.stderr.length = 0;
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY);
  expect(await runAction({ ...r.env(), INPUT_SINCE: 'x\n::error::y' }, fakeGh().gh)).toBe(1);
  expect(r.stderr.join('\n')).toMatch(/since/);
  expectOnlyStopPair(r);
});

test('C1 a successful run is wrapped in the stop/resume pair as well', async () => {
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY.replace(/cutSessions: 0/, 'cutSessions: 100000').replace(/costIncreasePct: 10/, 'costIncreasePct: 100000'));
  await runAction(r.env(), fakeGh().gh);
  expectOnlyStopPair(r);
});
