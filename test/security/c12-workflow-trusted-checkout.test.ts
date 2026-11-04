// C12 (security review C): .github/workflows/policy-replay.yml checked the trusted base code out inside the PR's
// workspace (path .tokenyard-trusted) and skipped the replay silently when .tokenyard-trusted/action.yml was missing.
// A PR committing a symbolic link `.tokenyard-trusted -> .` turned the second checkout into a checkout of the workspace
// repository itself (actions/checkout v4 follows the link, reuses the .git it finds, checks out the base there and
// removes the link), hashFiles() was empty, the replay step was skipped and the job was green. Now the job fails when
// the trusted path exists before its checkout, an explicit step checks that the trusted checkout is a real directory
// with its own repository at the base commit, and only a base commit without action.yml skips, with a visible notice.
// This test runs the workflow's own shell steps against the attack, replaying the second checkout with real git the
// way the security probe does (the operations of actions/checkout v4 for an existing directory).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const TRUSTED = '.tokenyard-trusted';
interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
const steps = (): Step[] => (parse(readFileSync(join(ROOT, '.github/workflows/policy-replay.yml'), 'utf8')) as { jobs: { replay: { steps: Step[] } } }).jobs.replay.steps;

let tmp: string;
const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ty-c12-')));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** origin with a base commit (with or without action.yml) and a PR commit, optionally adding the symbolic link. */
function origin(o: { link: boolean; action: boolean }): { origin: string; baseSha: string } {
  const src = join(tmp, 'src');
  mkdirSync(join(src, 'examples/pr-demo/policy'), { recursive: true });
  g(src, 'init', '-q', '-b', 'main');
  if (o.action) writeFileSync(join(src, 'action.yml'), readFileSync(join(ROOT, 'action.yml')));
  writeFileSync(join(src, 'examples/pr-demo/policy/policy.yaml'), 'base\n');
  g(src, 'add', '-A');
  g(src, 'commit', '-qm', 'base');
  const baseSha = g(src, 'rev-parse', 'HEAD');
  g(src, 'checkout', '-qb', 'pr');
  writeFileSync(join(src, 'examples/pr-demo/policy/policy.yaml'), 'pr weakens the policy\n');
  if (o.link) symlinkSync('.', join(src, TRUSTED));
  g(src, 'add', '-A');
  g(src, 'commit', '-qm', 'pr');
  const bare = join(tmp, 'origin.git');
  g(tmp, 'clone', '-q', '--bare', src, bare);
  return { origin: bare, baseSha };
}

/** checkout #1: the PR head into the workspace. */
function checkoutPr(bare: string): string {
  const ws = join(tmp, 'ws');
  g(tmp, 'clone', '-q', '--no-checkout', bare, ws);
  g(ws, 'checkout', '-q', '--force', g(ws, 'rev-parse', 'origin/pr'));
  return ws;
}

/** checkout #2 at path .tokenyard-trusted, as actions/checkout v4 does it (an existing directory with a matching .git is reused). */
function checkoutTrusted(ws: string, bare: string, ref: string): void {
  const path = resolve(ws, TRUSTED);
  if (existsSync(path) && statSync(path).isDirectory() && existsSync(join(path, '.git')) && g(path, 'config', '--get', 'remote.origin.url') === bare) {
    g(path, 'checkout', '-q', '--detach');
    g(path, 'clean', '-ffdx');
    g(path, 'reset', '--hard', 'HEAD');
  } else {
    mkdirSync(path, { recursive: true });
    g(path, 'init', '-q');
    g(path, 'remote', 'add', 'origin', bare);
  }
  g(path, 'fetch', '-q', 'origin', ref);
  g(path, 'checkout', '-q', '--progress', '--force', ref);
}

/** Runs one `run:` step of the workflow with bash in the workspace; returns its exit status, stdout and outputs. */
function runStep(step: Step, ws: string, baseSha: string): { status: number | null; stdout: string; outputs: string } {
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, v.includes('base.sha') ? baseSha : v]));
  const r = spawnSync('bash', ['-e', '-c', step.run ?? 'exit 99'], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: out, ...env } });
  return { status: r.status, stdout: r.stdout, outputs: readFileSync(out, 'utf8') };
}

test('C12 the workflow has a guard before the trusted checkout, an explicit check after it, and no hashFiles skip', () => {
  const s = steps();
  const text = readFileSync(join(ROOT, '.github/workflows/policy-replay.yml'), 'utf8');
  expect(text).not.toContain('hashFiles');
  const trustedCheckout = s.findIndex((x) => x.uses?.startsWith('actions/checkout') && x.with?.path === TRUSTED);
  const prCheckout = s.findIndex((x) => x.uses?.startsWith('actions/checkout') && x.with?.path === undefined);
  const guard = s.findIndex((x) => x.run?.includes(TRUSTED) && x.id !== 'trusted');
  const check = s.findIndex((x) => x.id === 'trusted');
  const replay = s.findIndex((x) => x.id === 'replay');
  expect(prCheckout).toBe(0);
  expect(prCheckout < guard && guard < trustedCheckout && trustedCheckout < check && check < replay).toBe(true);
  expect(s[replay]?.if).toBe("steps.trusted.outputs.run == 'true'");
  expect(s[replay]?.uses).toBe(`./${TRUSTED}`);
});

test.skipIf(process.platform === 'win32')('C12 a PR committing .tokenyard-trusted as a symbolic link fails the job, it is never skipped', () => {
  const s = steps();
  const guard = s.find((x) => x.run?.includes(TRUSTED) && x.id !== 'trusted');
  const check = s.find((x) => x.id === 'trusted');
  if (!guard || !check) throw new Error('workflow steps missing');
  const { origin: bare, baseSha } = origin({ link: true, action: true });
  const ws = checkoutPr(bare);
  // the guard fails the job before the trusted checkout
  const first = runStep(guard, ws, baseSha);
  expect(first.status).not.toBe(0);
  expect(first.stdout).toMatch(/^::error/m);
  // and if the second checkout ran anyway (the probe's attack), the explicit check fails instead of skipping
  checkoutTrusted(ws, bare, baseSha);
  expect(existsSync(join(ws, TRUSTED))).toBe(false); // the link is gone: the old hashFiles() condition would be empty
  const second = runStep(check, ws, baseSha);
  expect(second.status).not.toBe(0);
  expect(second.outputs).not.toMatch(/run=false/);
});

test.skipIf(process.platform === 'win32')('C12 an honest PR runs the replay; a base without action.yml skips with a notice; a wrong commit fails', () => {
  const check = steps().find((x) => x.id === 'trusted');
  const guard = steps().find((x) => x.run?.includes(TRUSTED) && x.id !== 'trusted');
  if (!check || !guard) throw new Error('workflow steps missing');
  const { origin: bare, baseSha } = origin({ link: false, action: true });
  const ws = checkoutPr(bare);
  expect(runStep(guard, ws, baseSha).status).toBe(0);
  checkoutTrusted(ws, bare, baseSha);
  const ok = runStep(check, ws, baseSha);
  expect(ok).toMatchObject({ status: 0, outputs: 'run=true\n' });
  // the trusted checkout at another commit than the event's base
  const wrong = runStep(check, ws, 'f'.repeat(40));
  expect(wrong.status).not.toBe(0);

  rmSync(join(tmp), { recursive: true, force: true });
  mkdirSync(tmp);
  const noAction = origin({ link: false, action: false });
  const ws2 = checkoutPr(noAction.origin);
  checkoutTrusted(ws2, noAction.origin, noAction.baseSha);
  const skip = runStep(check, ws2, noAction.baseSha);
  expect(skip.status).toBe(0);
  expect(skip.outputs).toBe('run=false\n');
  expect(skip.stdout).toMatch(/^::notice .*no action\.yml/m);
});
