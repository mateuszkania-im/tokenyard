import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { appendKey } from '../../src/edge/keys.js';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { parsePolicyFiles, PolicyLoadError } from '../../src/policy/load-dir.js';
import { policyJsonSchema } from '../../src/policy/json-schema.js';
import { policySchema } from '../../src/policy/schema.js';

const EXAMPLE = 'examples/policy';
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ty-policy-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = (): Record<string, string> => ({
  'policy.yaml': readFileSync(join(EXAMPLE, 'policy.yaml'), 'utf8'),
  'prices.yaml': readFileSync(join(EXAMPLE, 'prices.yaml'), 'utf8'),
  'keys.yaml': readFileSync(join(EXAMPLE, 'keys.yaml'), 'utf8'),
});

function loadCode(files: Record<string, string>): string | null {
  try {
    parsePolicyFiles('x', files);
    return null;
  } catch (e) {
    return e instanceof PolicyLoadError ? e.code : `OTHER:${String(e)}`;
  }
}

test('policy schema output is valid JSON Schema and lists every top-level key', () => {
  const js = policyJsonSchema() as { $schema?: string; type?: string; properties?: Record<string, unknown> };
  expect(JSON.parse(JSON.stringify(js))).toEqual(js);
  expect(js.type).toBe('object');
  expect(js.$schema).toMatch(/json-schema\.org/);
  const keys = Object.keys(policySchema.shape);
  expect(keys).toEqual(expect.arrayContaining(['apiVersion', 'kind', 'metadata', 'pricing', 'keys', 'providers', 'tenants', 'routes', 'budgets', 'reservation', 'rateLimits', 'guardrails', 'failure', 'ci']));
  expect(Object.keys(js.properties ?? {}).sort()).toEqual([...keys].sort());
});

test('the example policy parses and defaults the reservation settings', async () => {
  const src = await loadPolicyDir(EXAMPLE);
  expect(src.policy.reservation.assumedMaxUses).toBe(25);
  expect(src.policy.guardrails.secrets.taintTtlHours).toBe(24);
  expect(src.policy.rateLimits.some((r) => r.concurrentStreams === 8)).toBe(true);
  expect(src.keys.length).toBeGreaterThan(0);
  expect(Object.keys(src.normalizedFiles).sort()).toEqual(['keys.yaml', 'policy.yaml', 'prices.yaml']);
});

test('CRLF and BOM copies of examples/policy parse to the same normalizedFiles', async () => {
  const plain = await loadPolicyDir(EXAMPLE);
  for (const mangle of [(t: string) => t.replace(/\n/g, '\r\n'), (t: string) => `\uFEFF${t}`, (t: string) => `\uFEFF${t.replace(/\n/g, '\r\n')}`]) {
    const dir = tmp();
    cpSync(EXAMPLE, dir, { recursive: true });
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), mangle(readFileSync(join(dir, f), 'utf8')));
    const copy = await loadPolicyDir(dir);
    expect(copy.normalizedFiles).toEqual(plain.normalizedFiles);
    expect(copy.policy).toEqual(plain.policy);
  }
});

test('a keys file written by appendKey loads', async () => {
  const dir = tmp();
  cpSync(EXAMPLE, dir, { recursive: true });
  writeFileSync(join(dir, 'keys.yaml'), '');
  const rec = { hash: 'b'.repeat(64), keyId: 'key_bbbbbbbb', tenant: 'acme', team: 'web', name: 'bob', kind: 'developer', billing: 'api' } as const;
  await appendKey(join(dir, 'keys.yaml'), rec);
  await appendKey(join(dir, 'keys.yaml'), { ...rec, hash: 'c'.repeat(64), keyId: 'key_cccccccc', team: null, name: 'svc', kind: 'service' });
  const src = await loadPolicyDir(dir);
  expect(src.keys.map((k) => k.name)).toEqual(['bob', 'svc']);
  expect(src.keys[1]?.team).toBeNull();
});

test('an empty keys file means no keys', () => {
  expect(parsePolicyFiles('x', { ...base(), 'keys.yaml': '' }).keys).toEqual([]);
});

test('a nested alias bomb fails fast with E_YAML_UNSAFE, in policy, prices and keys', () => {
  const bomb = 'a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]\n';
  const t0 = Date.now();
  for (const f of ['policy.yaml', 'prices.yaml', 'keys.yaml']) {
    expect(loadCode({ ...base(), [f]: f === 'keys.yaml' ? `- &k {x: 1}\n- *k\n` : bomb })).toBe('E_YAML_UNSAFE');
  }
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('merge keys and __proto__ keys are rejected at parse time and nothing is polluted', () => {
  const p = base()['policy.yaml'] as string;
  expect(loadCode({ ...base(), 'policy.yaml': `${p}x-base: &b {a: 1}\nx-m:\n  <<: {a: 1}\n` })).toBe('E_YAML_UNSAFE');
  const spots = [
    p.replace('providers:\n', 'providers:\n  "__proto__": { format: anthropic, baseUrl: https://api.anthropic.com, credential: { env: X } }\n'),
    p.replace('tenants:\n', 'tenants:\n  "__proto__": { teams: [] }\n'),
    `${p}\nx-bad: { "__proto__": { polluted: true } }\n`,
  ];
  for (const text of spots) expect(loadCode({ ...base(), 'policy.yaml': text })).toBe('E_YAML_UNSAFE');
  expect(loadCode({ ...base(), 'keys.yaml': '- {"__proto__": {"x": 1}, "hash": "a"}\n' })).toBe('E_YAML_UNSAFE');
  expect(loadCode({ ...base(), 'prices.yaml': 'version: x\nmodels:\n  "__proto__": { input: 1 }\n' })).toBe('E_YAML_UNSAFE');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test('unknown top-level keys, bad shapes and syntax errors carry stable load codes', () => {
  const p = base()['policy.yaml'] as string;
  expect(loadCode({ ...base(), 'policy.yaml': `${p}surprise: 1\n` })).toBe('E_SCHEMA');
  expect(loadCode({ ...base(), 'policy.yaml': 'a: [\n' })).toBe('E_YAML_SYNTAX');
  expect(loadCode({ ...base(), 'keys.yaml': '- {hash: nope}\n' })).toBe('E_SCHEMA');
  expect(loadCode({ ['prices.yaml']: base()['prices.yaml'] as string, 'keys.yaml': '' })).toBe('E_FILE_MISSING');
  expect(loadCode({ ...base(), 'prices.yaml': 'version: x\nmodels: {}\nmodifiers: 3\n' })).toBe('E_PRICES_INVALID');
  const noLimits = (base()['prices.yaml'] as string).replace(/ {4}maxContextTokens: \d+\n/, '');
  expect(loadCode({ ...base(), 'prices.yaml': noLimits })).toBe('E_MODEL_LIMITS_MISSING');
});

test('pricing and keys must name a file in the policy directory', () => {
  const p = base()['policy.yaml'] as string;
  for (const ref of ['../prices.yaml', '/etc/prices.yaml', 'sub/prices.yaml', 'http://x/prices.yaml']) {
    expect(loadCode({ ...base(), 'policy.yaml': p.replace('pricing: ./prices.yaml', `pricing: ${ref}`) })).toBe('E_SCHEMA');
  }
});

test('duplicate key hashes are refused', () => {
  const line = `- {"hash":"${'d'.repeat(64)}","keyId":"key_dddddddd","tenant":"acme","team":null,"name":"n","kind":"developer","billing":"api"}\n`;
  expect(loadCode({ ...base(), 'keys.yaml': line + line })).toBe('E_SCHEMA');
});
