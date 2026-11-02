import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { parsePolicyFiles, PolicyLoadError } from '../../src/policy/load-dir.js';
import { ERROR_CODES, LOAD_ERROR_CODES, validatePolicy, WARNING_CODES } from '../../src/policy/validate.js';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'tokenyard.mjs');
const FIX = 'test/fixtures/policy';
const EXAMPLE = 'examples/policy';
const flagsOf = (dir: string): { experimentalSubscription: boolean } => {
  const f = join(dir, 'flags.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { experimentalSubscription: boolean }) : { experimentalSubscription: false };
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const copyExample = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ty-validate-'));
  dirs.push(d);
  cpSync(EXAMPLE, d, { recursive: true });
  return d;
};
const edit = (dir: string, file: string, fn: (t: string) => string): void => writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8')));
const codesOf = async (dir: string, experimentalSubscription = false): Promise<string[]> => {
  const r = validatePolicy(await loadPolicyDir(dir), { experimentalSubscription });
  return [...r.errors, ...r.warnings].map((i) => i.code);
};

const VALIDATE_CODES = [...ERROR_CODES, ...WARNING_CODES];

test('every error and warning code has exactly one fixture directory, and the code lists are the documented ones', () => {
  expect(ERROR_CODES).toEqual(['E_CHAIN_UNKNOWN_PROVIDER', 'E_CHAIN_LENGTH', 'E_CODING_AGENT_FORMAT', 'E_CODING_AGENT_NON_CLAUDE', 'E_BODY_REWRITE', 'E_PASSTHROUGH_HOST', 'E_SUBSCRIPTION_FLAG', 'E_UNPRICED_MODEL', 'E_MODEL_LIMITS', 'E_UNPRICED_SERVER_TOOL', 'E_BUDGET_DUP', 'E_BUDGET_WINDOW', 'E_BUDGET_USD', 'E_STORE_DOWN_UNSTATED', 'E_CREDENTIAL_ENV']);
  expect(WARNING_CODES).toEqual(['W_CHILD_BUDGET', 'W_SURFACE_NO_ROUTE', 'W_ROUTE_SHADOWED', 'W_SESSION_AWARE_BLOCK', 'W_SERVER_TOOLS_ASSUME', 'W_SUBSCRIPTION_BLOCK']);
  expect(LOAD_ERROR_CODES).toEqual(['E_FILE_MISSING', 'E_YAML_UNSAFE', 'E_YAML_SYNTAX', 'E_SCHEMA', 'E_PRICES_INVALID', 'E_MODEL_LIMITS_MISSING']);
  expect(readdirSync(FIX).sort()).toEqual([...VALIDATE_CODES, 'E_YAML_UNSAFE', 'E_SCHEMA'].sort());
});

test.each(VALIDATE_CODES)('fixture %s produces exactly that issue code', async (code) => {
  const dir = join(FIX, code);
  const r = validatePolicy(await loadPolicyDir(dir), flagsOf(dir));
  expect([...r.errors, ...r.warnings].map((i) => i.code)).toEqual([code]);
});

test.each(['E_YAML_UNSAFE', 'E_SCHEMA'])('fixture %s fails to load with that code', async (code) => {
  await expect(loadPolicyDir(join(FIX, code))).rejects.toMatchObject({ code });
  await expect(loadPolicyDir(join(FIX, code))).rejects.toBeInstanceOf(PolicyLoadError);
});

test('examples/policy validates with 0 errors', async () => {
  const r = validatePolicy(await loadPolicyDir(EXAMPLE), { experimentalSubscription: false });
  expect(r.errors).toEqual([]);
});

test('issues carry code, path and message', async () => {
  const r = validatePolicy(await loadPolicyDir(join(FIX, 'E_CHAIN_UNKNOWN_PROVIDER')), { experimentalSubscription: false });
  expect(r.errors[0]).toMatchObject({ code: 'E_CHAIN_UNKNOWN_PROVIDER', path: 'routes[0].chain[1]' });
  expect(r.errors[0]?.message).toContain('nope');
});

test('passthrough credential is valid with experimentalSubscription true and E_SUBSCRIPTION_FLAG without', async () => {
  const d = copyExample();
  edit(d, 'policy.yaml', (t) => t.replace('credential: { env: OPENAI_API_KEY }', 'credential: passthrough'));
  expect(await codesOf(d, false)).toContain('E_SUBSCRIPTION_FLAG');
  expect(await codesOf(d, true)).not.toContain('E_SUBSCRIPTION_FLAG');
  expect((await codesOf(d, true)).filter((c) => c.startsWith('E_'))).toEqual([]);
});

test('passthrough only to the official host of the provider format, https, no port', async () => {
  for (const url of ['https://api.openai.com.evil.example/v1', 'https://api.anthropic.com/v1', 'http://api.openai.com/v1', 'https://api.openai.com:8443/v1', 'https://api.openai.com@evil.example/v1']) {
    const d = copyExample();
    edit(d, 'policy.yaml', (t) => t.replace('credential: { env: OPENAI_API_KEY }', 'credential: passthrough').replace('https://api.openai.com/v1', url));
    expect(await codesOf(d, true), url).toContain('E_PASSTHROUGH_HOST');
  }
});

test('a route matching billing subscription is E_SUBSCRIPTION_FLAG without the flag', async () => {
  const d = copyExample();
  edit(d, 'policy.yaml', (t) => t.replace('billing: api }', 'billing: subscription }'));
  expect(await codesOf(d, false)).toContain('E_SUBSCRIPTION_FLAG');
  expect(await codesOf(d, true)).not.toContain('E_SUBSCRIPTION_FLAG');
});

test('names like __proto__-adjacent built-ins never resolve in provider, budget, route, key and tenant positions', async () => {
  const names = ['constructor', 'hasOwnProperty', 'toString', 'valueOf'];
  for (const n of names) {
    // as a provider name that exists
    const d = copyExample();
    edit(d, 'policy.yaml', (t) => t.replace('  openai:\n', `  ${n}:\n`).replace('chain: [openai]', `chain: [${n}]`));
    expect((await codesOf(d)).filter((c) => c.startsWith('E_')), n).toEqual([]);
    // as a provider name that does not exist
    const d2 = copyExample();
    edit(d2, 'policy.yaml', (t) => t.replace('chain: [openai]', `chain: [${n}]`));
    expect(await codesOf(d2), n).toContain('E_CHAIN_UNKNOWN_PROVIDER');
    // as route, budget and tenant names; duplicate detection must not trip on built-ins
    const d3 = copyExample();
    edit(d3, 'policy.yaml', (t) => t.replace('name: codex', `name: ${n}`).replace('name: org-month', `name: ${n}`).replace('  acme:', `  ${n}:`));
    expect((await codesOf(d3)).filter((c) => c.startsWith('E_')), n).toEqual([]);
    // as an allowed model, resolved against the price table
    const d4 = copyExample();
    edit(d4, 'policy.yaml', (t) => t.replace('allowModels: ["claude-opus-5-5*"', `allowModels: ["${n}", "claude-opus-5-5*"`));
    expect(await codesOf(d4), n).toContain('E_UNPRICED_MODEL');
    // as a key's tenant and team
    const d5 = copyExample();
    edit(d5, 'keys.yaml', (t) => t.replace('tenant: acme', `tenant: ${n}`).replace(/"tenant":"acme"/, `"tenant":"${n}"`));
    expect((await codesOf(d5)).filter((c) => c.startsWith('E_')), n).toEqual([]);
  }
});

test('E_UNPRICED_MODEL covers wildcard patterns with no priced match and the rewrite target', async () => {
  const d = copyExample();
  edit(d, 'policy.yaml', (t) => t.replace('"claude-haiku-*"', '"claude-nothing-*"'));
  expect(await codesOf(d)).toContain('E_UNPRICED_MODEL');
  const d2 = copyExample();
  edit(d2, 'policy.yaml', (t) => t.replace(/rewriteModel: [\w.-]+/, 'rewriteModel: claude-haiku-9'));
  expect(await codesOf(d2)).toContain('E_UNPRICED_MODEL');
});

test('an api-mode provider whose credential env name is invalid is an error; whether it is set is not checked', async () => {
  const d = copyExample();
  edit(d, 'policy.yaml', (t) => t.replace('env: OPENAI_API_KEY', 'env: "has space"'));
  expect(await codesOf(d)).toContain('E_CREDENTIAL_ENV');
  delete process.env.ANTHROPIC_API_KEY;
  expect((await codesOf(copyExample())).filter((c) => c.startsWith('E_'))).toEqual([]);
});

test('E_MODEL_LIMITS also covers a price table that omits the limits (load-time)', () => {
  const files = Object.fromEntries(['policy.yaml', 'prices.yaml', 'keys.yaml'].map((f) => [f, readFileSync(join(EXAMPLE, f), 'utf8')]));
  const bad = { ...files, 'prices.yaml': files['prices.yaml']!.replace(/ {4}maxOutputTokens: 128000\n/, '') };
  expect(() => parsePolicyFiles('x', bad)).toThrowError(expect.objectContaining({ code: 'E_MODEL_LIMITS_MISSING' }));
});

async function runCheck(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await promisify(execFile)('node', [BIN, 'policy', 'check', ...args]);
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout + x.stderr };
  }
}

test('policy check exits 1 on errors, 0 with warnings, and prints code and path per issue', async () => {
  const ok = await runCheck([EXAMPLE]);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain('0 errors');
  const warn = await runCheck([join(FIX, 'W_CHILD_BUDGET')]);
  expect(warn.code).toBe(0);
  expect(warn.out).toMatch(/W_CHILD_BUDGET budgets\[1\]/);
  expect(warn.out).toContain('0 errors, 1 warnings');
  const bad = await runCheck([join(FIX, 'E_CHAIN_UNKNOWN_PROVIDER')]);
  expect(bad.code).toBe(1);
  expect(bad.out).toMatch(/E_CHAIN_UNKNOWN_PROVIDER routes\[0\]\.chain\[1\]/);
  expect(bad.out).toContain('1 errors');
  const load = await runCheck([join(FIX, 'E_YAML_UNSAFE')]);
  expect(load.code).toBe(1);
  expect(load.out).toContain('E_YAML_UNSAFE');
  const flagged = await runCheck([join(FIX, 'E_SUBSCRIPTION_FLAG')]);
  expect(flagged.code).toBe(1);
  expect((await runCheck([join(FIX, 'E_SUBSCRIPTION_FLAG'), '--experimental-subscription'])).out).toContain('W_SUBSCRIPTION_BLOCK');
  const missing = await runCheck([join(FIX, 'does-not-exist')]);
  expect(missing.code).toBe(1);
  expect(missing.out).toContain('E_FILE_MISSING');
});

test('policy schema prints JSON Schema', async () => {
  const r = await promisify(execFile)('node', [BIN, 'policy', 'schema']);
  const js = JSON.parse(r.stdout) as { properties: Record<string, unknown> };
  expect(Object.keys(js.properties)).toContain('routes');
});
