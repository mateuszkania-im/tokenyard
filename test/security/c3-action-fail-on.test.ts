// C3 (security review C): the gate used the head policy's ci.failOn, so the pull request under test set its own
// thresholds. The gate now uses the stricter of base and head for each threshold, and the comment says when the PR
// changes ci.failOn.
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

test('C3 a PR that raises its own ci.failOn thresholds still fails the base gate, and the comment says so', async () => {
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY.replace(/cutSessions: 0/, 'cutSessions: 100000').replace(/costIncreasePct: 10/, 'costIncreasePct: 100000'));
  const f = fakeGh();
  expect(await runAction(r.env(), f.gh)).toBe(1);
  expect(r.replayJson().gates.failed.length).toBeGreaterThan(0);
  expect(f.created[0]).toMatch(/changes ci\.failOn/);
});

test('C3 a PR that lowers a threshold gets the stricter value', async () => {
  // the demo change cuts sessions; with the base's cutSessions 0 it fails, and lowering costIncreasePct keeps it failing
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY.replace(/costIncreasePct: 10/, 'costIncreasePct: 0'));
  const f = fakeGh();
  expect(await runAction(r.env(), f.gh)).toBe(1);
  expect(f.created[0]).toMatch(/changes ci\.failOn/);
  // no change to ci.failOn: no note
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY);
  const g = fakeGh();
  await runAction(r.env(), g.gh);
  expect(g.created[0]).not.toMatch(/changes ci\.failOn/);
});
