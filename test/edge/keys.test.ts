import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, test } from 'vitest';
import { appendKey, createKey } from '../../src/edge/keys.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const decode = (s: string): bigint => [...s].reduce((n, c) => n * 62n + BigInt(B62.indexOf(c)), 0n);

test('createKey: ty_live_ prefix, 32 random bytes, hash is sha256 hex of plaintext', () => {
  const { plaintext, hash } = createKey();
  expect(plaintext).toMatch(/^ty_live_[0-9A-Za-z]{43}$/);
  expect(decode(plaintext.slice('ty_live_'.length)) < 2n ** 256n).toBe(true);
  expect(hash).toBe(createHash('sha256').update(plaintext).digest('hex'));
  expect(createKey().plaintext).not.toBe(plaintext);
});

test('appendKey appends records to a YAML list, creating the file, and never stores the plaintext', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ty-keys-'));
  try {
    const file = join(dir, 'keys.yaml');
    const a = createKey();
    const b = createKey();
    const rec = { keyId: 'k1', tenant: 'acme', team: 'web', name: 'alice', kind: 'developer', billing: 'api' } as const;
    await appendKey(file, { ...rec, hash: a.hash });
    await appendKey(file, { ...rec, keyId: 'k2', name: 'bob: the "second"', team: null, hash: b.hash });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(a.plaintext);
    expect(parse(text)).toEqual([
      { ...rec, hash: a.hash },
      { ...rec, keyId: 'k2', name: 'bob: the "second"', team: null, hash: b.hash },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
