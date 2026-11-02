import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildEnvExport } from '../../src/env.js';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'tokenyard.mjs');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ty-env-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
const run = async (...args: string[]) => (await promisify(execFile)('node', [BIN, 'env', ...args], { cwd: dir })).stdout;

test('buildEnvExport: ticket from the branch with the default pattern, custom pattern, none', () => {
  const out = buildEnvExport({ repo: 'acme/web', branch: 'feature/WEB-12-login', ticketPattern: null, existing: null });
  expect(out).toBe("export ANTHROPIC_CUSTOM_HEADERS='x-tokenyard-repo: acme/web\nx-tokenyard-branch: feature/WEB-12-login\nx-tokenyard-ticket: WEB-12'\n");
  expect(buildEnvExport({ repo: 'r', branch: 'fix-1234-x', ticketPattern: 'fix-(\\d+)', existing: null })).toContain('x-tokenyard-ticket: 1234');
  expect(buildEnvExport({ repo: 'r', branch: 'main', ticketPattern: null, existing: null })).not.toContain('ticket');
});

test('buildEnvExport keeps headers already set and shell-quotes values', () => {
  const out = buildEnvExport({ repo: "o'brien", branch: 'main', ticketPattern: null, existing: 'x-tokenyard-key: ty_live_x' });
  expect(out.startsWith("export ANTHROPIC_CUSTOM_HEADERS='x-tokenyard-key: ty_live_x\n")).toBe(true);
  expect(out).toContain("x-tokenyard-repo: o'\\''brien");
});

test('tokenyard env prints ANTHROPIC_CUSTOM_HEADERS with repo, branch and ticket parsed by --ticket-pattern', async () => {
  git('init', '-q', '-b', 'feature/WEB-12-login');
  git('remote', 'add', 'origin', 'git@github.com:acme/web-shop.git');
  const out = await run();
  expect(out).toBe("export ANTHROPIC_CUSTOM_HEADERS='x-tokenyard-repo: web-shop\nx-tokenyard-branch: feature/WEB-12-login\nx-tokenyard-ticket: WEB-12'\n");
  git('checkout', '-q', '-b', 'task_77_cleanup');
  expect(await run('--ticket-pattern', 'task_(\\d+)')).toContain('x-tokenyard-ticket: 77');
});
