// Live-test harness (spec 14.1, R12): the guard, the live policy, the cap seeded from earlier live traces, and key
// handling. Runs in CI against the mock: no real key is ever used here.
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';
import { TraceWriter } from '../../src/ledger/writer.js';
import { defaultLivePaths, LIVE_LOCK_FILE, liveGuard, loadLivePolicy, startLiveHarness } from '../../src/live/harness.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { msgBody, send } from '../helpers/conformance.js';
import { baseRecord } from '../helpers/trace.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

const TODAY = '2026-11-02';
const KEY = 'sk-ant-test-CANARY-0123456789abcdef';

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ty-live-'));
  closers.push(() => {
    try {
      chmodSync(d, 0o700);
    } catch {
      // already gone
    }
    rmSync(d, { recursive: true, force: true });
  });
  return d;
}

async function mock() {
  const m = await startAnthropicMock();
  closers.push(m.close);
  return m;
}

const auth = (key: string) => ({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key, 'user-agent': 'claude-cli/9.9.9 (external, cli)' });

test('liveGuard refuses without ANTHROPIC_API_KEY, after 2026-11-16, without TOKENYARD_LIVE_BUDGET_USD or with a value above 20', () => {
  const ok = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  expect(liveGuard(ok, TODAY)).toEqual({ ok: true, capUsd: 20, codexLive: false });
  expect(liveGuard(ok, '2026-11-16')).toMatchObject({ ok: true });
  expect(liveGuard({ ...ok, ANTHROPIC_API_KEY: undefined }, TODAY)).toMatchObject({ ok: false, reason: expect.stringContaining('ANTHROPIC_API_KEY') });
  expect(liveGuard({ ...ok, ANTHROPIC_API_KEY: '' }, TODAY)).toMatchObject({ ok: false });
  expect(liveGuard(ok, '2026-11-17')).toMatchObject({ ok: false, reason: expect.stringContaining('2026-11-16') });
  expect(liveGuard(ok, '2026-12-01')).toMatchObject({ ok: false });
  expect(liveGuard({ ANTHROPIC_API_KEY: KEY }, TODAY)).toMatchObject({ ok: false, reason: expect.stringContaining('TOKENYARD_LIVE_BUDGET_USD') });
  for (const v of ['20.01', '21', '0', '-1', 'abc', '', 'Infinity', 'NaN']) {
    expect(liveGuard({ ...ok, TOKENYARD_LIVE_BUDGET_USD: v }, TODAY), v).toMatchObject({ ok: false });
  }
  expect(liveGuard({ ...ok, TOKENYARD_LIVE_BUDGET_USD: '3.5' }, TODAY)).toEqual({ ok: true, capUsd: 3.5, codexLive: false });
  // No reason ever carries the key value.
  for (const r of [liveGuard({ ...ok, TOKENYARD_LIVE_BUDGET_USD: '99' }, TODAY), liveGuard(ok, '2027-01-01')]) {
    expect(JSON.stringify(r)).not.toContain('CANARY');
  }
});

test('liveGuard reports codexLive from presence of OPENAI_API_KEY only', () => {
  const ok = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  expect(liveGuard({ ...ok, OPENAI_API_KEY: 'sk-proj-test-CANARY' }, TODAY)).toEqual({ ok: true, capUsd: 20, codexLive: true });
  expect(liveGuard({ ...ok, OPENAI_API_KEY: '' }, TODAY)).toEqual({ ok: true, capUsd: 20, codexLive: false });
  expect(liveGuard(ok, TODAY)).toEqual({ ok: true, capUsd: 20, codexLive: false });
  expect(JSON.stringify(liveGuard({ ...ok, OPENAI_API_KEY: 'sk-proj-test-CANARY' }, TODAY))).not.toContain('CANARY');
});

test('live policy has one enforced tenant budget live-total equal to the env cap, worst-case estimator, serverToolsWithoutMaxUses block', () => {
  const p = loadLivePolicy({ capUsd: 7.5, keyHash: hashKey('ty_live_x') });
  expect(p.budgets).toEqual([{ name: 'live-total', scope: 'tenant', window: 'month', limitMicroUsd: 7_500_000, enforce: true, enforceSubscription: true }]);
  expect(p.reservation.estimator).toBe('worst-case');
  expect(p.reservation.serverToolsWithoutMaxUses).toBe('block');
  expect(p.failure.unpricedModel).toBe('block');
  // The one key belongs to tenant live, so the tenant budget covers every route it can reach.
  expect([...p.keysByHash.values()]).toEqual([expect.objectContaining({ tenant: 'live', kind: 'developer', billing: 'api' })]);
  expect(p.keysByHash.has(hashKey('ty_live_x'))).toBe(true);
  // Credentials are environment references, never values.
  expect(p.providers.get('anthropic')?.credential).toEqual({ env: 'ANTHROPIC_API_KEY' });
  expect(p.providers.get('openai')?.credential).toEqual({ env: 'OPENAI_API_KEY' });
  // The copied price table is the example table, byte for byte, and not a symlink.
  const here = join(import.meta.dirname, 'prices.yaml');
  expect(statSync(here).isFile()).toBe(true);
  expect(readFileSync(here, 'utf8')).toBe(readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'policy', 'prices.yaml'), 'utf8'));
});

async function seeded(spentMicroUsd: number) {
  const dir = tmp();
  const w = new TraceWriter({ dir, instanceId: 'earlier1', queueMax: 10, clock: Date.now });
  const r = baseRecord({ tenant: 'live', team: 'live', ts: new Date().toISOString() });
  w.write({ ...r, outcome: { ...r.outcome, costMicroUsd: 1, chargedMicroUsd: spentMicroUsd } });
  await w.close();
  return dir;
}

test('harness seeds spend from earlier live traces: $19.99 spent means a $0.02 reservation is refused', async () => {
  const m = await mock();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const env = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  // About $0.02 reserved: Haiku 5.5, a small body plus the 4,096 token overhead at $1.1 per MTok, 6,000 output tokens at $2.75 per MTok.
  const body = msgBody({ model: 'claude-haiku-5-5', max_tokens: 6_000 });

  const full = await startLiveHarness({ env, today: TODAY, traceDir: await seeded(19_990_000), port: 0, upstream: m.url });
  closers.push(full.close);
  expect(full.spentMicroUsd).toBe(19_990_000);
  const refused = await send(full.url, { path: '/v1/messages', headers: auth(full.clientKey), body });
  expect(refused.status).toBe(429);
  expect(refused.body.toString()).toContain('live-total');
  expect(m.received).toHaveLength(0);

  // The same request fits when $19.90 was spent: the reservation is about $0.02, not more.
  const roomy = await startLiveHarness({ env, today: TODAY, traceDir: await seeded(19_900_000), port: 0, upstream: m.url });
  closers.push(roomy.close);
  expect((await send(roomy.url, { path: '/v1/messages', headers: auth(roomy.clientKey), body })).status).toBe(200);
  expect(m.received).toHaveLength(1);
});

test('unreadable trace dir refuses to start', async () => {
  const m = await mock();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const env = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  const notADir = join(tmp(), 'traces');
  writeFileSync(notADir, 'x');
  await expect(startLiveHarness({ env, today: TODAY, traceDir: notADir, port: 0, upstream: m.url })).rejects.toThrow(/trace/);
  // A directory without read permission (POSIX, not root: root reads it anyway).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = await seeded(1);
    const tenantDir = join(locked, 'live');
    chmodSync(tenantDir, 0o000);
    closers.push(() => chmodSync(tenantDir, 0o700));
    await expect(startLiveHarness({ env, today: TODAY, traceDir: locked, port: 0, upstream: m.url })).rejects.toThrow(/trace/);
  }
  // The guard runs before anything else.
  await expect(startLiveHarness({ env, today: '2026-11-17', traceDir: tmp(), port: 0, upstream: m.url })).rejects.toThrow(/2026-11-16/);
});

test('harness output and trace files never contain the provider key value', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-test-CANARY-0123456789abcdef', TOKENYARD_LIVE_BUDGET_USD: '20' };
  // start against the mock, send 3 requests, close; grep stdout, stderr and .live/traces for CANARY: none
  const m = await mock();
  const out: string[] = [];
  const capture = (chunk: unknown): boolean => (out.push(String(chunk)), true);
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  const traceDir = tmp();
  const h = await startLiveHarness({ env, today: TODAY, traceDir, port: 0, upstream: m.url });
  for (let i = 0; i < 3; i++) {
    const r = await send(h.url, { path: '/v1/messages', headers: auth(h.clientKey), body: msgBody({ model: 'claude-sonnet-5-5', stream: i === 1 }) });
    expect(r.status).toBe(200);
  }
  await h.close();
  // The gateway used the key from `env` (the provider credential), and only towards the provider.
  expect(m.received.map((r) => r.headers['x-api-key'])).toEqual([env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY]);
  expect(process.env.ANTHROPIC_API_KEY ?? '').not.toContain('CANARY');

  const printed = out.join('');
  expect(printed).toContain(h.url);
  expect(printed).toContain(h.clientKey);
  expect(printed).toMatch(/remaining/i);
  expect(printed).not.toContain('CANARY');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (p: string) => files.push(p))(join(d, e.name));
  };
  walk(traceDir);
  expect(files.length).toBeGreaterThan(0);
  const lines = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean));
  expect(lines.filter((l) => l.includes('"kind":"request"'))).toHaveLength(3);
  for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain('CANARY');
});

const REPO = resolve(import.meta.dirname, '..', '..');

test('the CLI has no --trace-dir for live: an unknown option is refused before anything starts', async () => {
  const r = await promisify(execFile)('node', [join(REPO, 'bin', 'tokenyard.mjs'), 'live', '--trace-dir', tmp(), '--port', '0'], {
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' },
    // A regression would start a gateway: kill it rather than leave it running.
    timeout: 4_000,
  }).then(
    () => ({ code: 0, stderr: '' }),
    (e: { code: number; stderr: string }) => e,
  );
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/unknown option '--trace-dir'/);
  expect(r.stderr).not.toContain('CANARY');
});

test('live paths are anchored at the package root, never the cwd: the same from another working directory', () => {
  const here = defaultLivePaths();
  expect(here).toEqual({ traceDir: join(REPO, '.live', 'traces'), policyDir: join(REPO, 'test', 'live') });
  expect(isAbsolute(here.traceDir) && isAbsolute(here.policyDir)).toBe(true);
  // A child process whose cwd is an unrelated directory resolves the same paths.
  const script = `import(${JSON.stringify(join(REPO, 'src', 'live', 'harness.ts'))}).then((m) => process.stdout.write(JSON.stringify(m.defaultLivePaths())))`;
  const r = spawnSync(process.execPath, ['--import', join(REPO, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), '--input-type=module', '-e', script], { cwd: tmp(), encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(JSON.parse(r.stdout)).toEqual(here);
});

test('a second harness on the same trace dir refuses while the first runs; close() releases the lock', async () => {
  const m = await mock();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const env = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  const traceDir = tmp();
  const first = await startLiveHarness({ env, today: TODAY, traceDir, port: 0, upstream: m.url });
  closers.push(first.close);
  expect(readFileSync(join(traceDir, LIVE_LOCK_FILE), 'utf8').trim()).toBe(String(process.pid));
  await expect(startLiveHarness({ env, today: TODAY, traceDir, port: 0, upstream: m.url })).rejects.toThrow(new RegExp(`another live harness \\(pid ${process.pid}\\)`));
  await first.close();
  expect(existsSync(join(traceDir, LIVE_LOCK_FILE))).toBe(false);
  const second = await startLiveHarness({ env, today: TODAY, traceDir, port: 0, upstream: m.url });
  closers.push(second.close);
  expect(existsSync(join(traceDir, LIVE_LOCK_FILE))).toBe(true);
});

test('a stale lock (its pid is not alive) is replaced', async () => {
  const m = await mock();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const env = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  const traceDir = tmp();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(join(traceDir, LIVE_LOCK_FILE), `${dead}\n`);
  const h = await startLiveHarness({ env, today: TODAY, traceDir, port: 0, upstream: m.url });
  closers.push(h.close);
  expect(readFileSync(join(traceDir, LIVE_LOCK_FILE), 'utf8').trim()).toBe(String(process.pid));
});

test('a start that fails after taking the lock releases it', async () => {
  const m = await mock();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const env = { ANTHROPIC_API_KEY: KEY, TOKENYARD_LIVE_BUDGET_USD: '20' };
  const traceDir = await seeded(1);
  const tenantDir = join(traceDir, 'live');
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  chmodSync(tenantDir, 0o000);
  closers.push(() => chmodSync(tenantDir, 0o700));
  await expect(startLiveHarness({ env, today: TODAY, traceDir, port: 0, upstream: m.url })).rejects.toThrow(/trace/);
  expect(existsSync(join(traceDir, LIVE_LOCK_FILE))).toBe(false);
});
