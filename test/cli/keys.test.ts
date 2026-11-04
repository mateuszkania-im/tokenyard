import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { expect, test } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'tokenyard.mjs');

test('tokenyard keys create prints the key once and appends only its hash to keys.yaml', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ty-keys-cli-'));
  try {
    const file = join(dir, 'keys.yaml');
    const { stdout } = await promisify(execFile)('node', [BIN, 'keys', 'create', '--tenant', 'acme', '--team', 'web', '--name', 'alice', '--file', file]);
    const plaintext = /ty_live_[0-9A-Za-z]{43}/.exec(stdout)?.[0] ?? '';
    expect(plaintext).not.toBe('');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(plaintext);
    const [rec] = parse(text) as Array<Record<string, unknown>>;
    expect(rec).toMatchObject({ hash: hashKey(plaintext), tenant: 'acme', team: 'web', name: 'alice', kind: 'developer', billing: 'api' });
    expect(rec?.keyId).toMatch(/^key_[0-9a-f]{8}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenyard keys create --billing subscription needs --experimental-subscription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ty-keys-cli-'));
  try {
    const args = [BIN, 'keys', 'create', '--tenant', 'a', '--name', 'n', '--file', join(dir, 'k.yaml'), '--billing', 'subscription'];
    await expect(promisify(execFile)('node', args)).rejects.toThrow(/experimental-subscription/);
    await promisify(execFile)('node', [...args, '--experimental-subscription']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
