// FR-I2 and FR-M7 (final review): `serve` warns on stderr at start when enforced budgets live in the memory store with
// no --trace-dir (spend is lost on restart), and for each provider whose credential variable is unset. Names only,
// never a value.
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { startupWarnings } from '../../src/edge/startup-warnings.js';
import { auditBudgets, PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { tempDir, writePolicyDir } from '../helpers/policy-dir.js';

const RESTART = /budgets are enforced on the memory store without --trace-dir/;

test('FR-I2 the restart warning needs an enforced budget, the memory store and no trace dir', () => {
  const env = { [PROVIDER_KEY_ENV]: 'set', OPENAI_API_KEY: 'set' };
  const enforced = testPolicy({ upstream: 'http://127.0.0.1:1' });
  expect(enforced.budgets.some((b) => b.enforce)).toBe(true);
  const has = (w: string[]): boolean => w.some((l) => RESTART.test(l));
  expect(has(startupWarnings(enforced, { store: 'memory', traceDir: false, env }))).toBe(true);
  expect(has(startupWarnings(enforced, { store: 'memory', traceDir: true, env }))).toBe(false);
  expect(has(startupWarnings(enforced, { store: 'redis', traceDir: false, env }))).toBe(false);
  expect(has(startupWarnings(testPolicy({ upstream: 'http://127.0.0.1:1', edit: auditBudgets }), { store: 'memory', traceDir: false, env }))).toBe(false);
  expect(startupWarnings(enforced, { store: 'memory', traceDir: true, env })).toEqual([]);
});

test('FR-M7 one warning per provider whose credential variable is unset or empty, naming the variable only', () => {
  const p = testPolicy({ upstream: 'http://127.0.0.1:1' });
  const w = startupWarnings(p, { store: 'redis', traceDir: false, env: { [PROVIDER_KEY_ENV]: '' } });
  expect(w).toHaveLength(3); // the test policy points all three providers at one variable
  for (const name of ['anthropic', 'anthropic-backup', 'openai']) expect(w).toContain(`tokenyard: warning: provider "${name}" reads its key from ${PROVIDER_KEY_ENV}, which is not set; its requests will get the provider's 401`);
  expect(startupWarnings(p, { store: 'redis', traceDir: false, env: { [PROVIDER_KEY_ENV]: 'sk-canary-value-1234' } })).toEqual([]);
  expect(startupWarnings(testPolicy({ upstream: 'https://api.anthropic.com', credential: 'passthrough' }), { store: 'redis', traceDir: false, env: {} }).filter((l) => l.includes('anthropic'))).toEqual([]);
});

test('FR-I2 and FR-M7 serve prints both warnings on stderr at start', async () => {
  const dir = tempDir();
  writePolicyDir(dir, 'http://127.0.0.1:1', 'warnings');
  const env: NodeJS.ProcessEnv = { ...process.env, [PROVIDER_KEY_ENV]: 'k' };
  delete env.OPENAI_API_KEY;
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--host', '127.0.0.1', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--no-metrics'], { env });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', () => reject(new Error(`serve exited early: ${stderr}`)));
    });
    await expect.poll(() => stderr).toMatch(RESTART);
    await expect.poll(() => stderr).toContain('provider "openai" reads its key from OPENAI_API_KEY, which is not set');
    expect(stderr).not.toContain(`reads its key from ${PROVIDER_KEY_ENV}`);
  } finally {
    child.kill('SIGKILL');
  }
});
