// C10 (security review C): the last-known-good file carries its own sha256, so the check catches accidental corruption
// only: whoever can write --state-dir can plant any policy that validates by recomputing the hash. Ruling: the sha256
// is documented as corruption detection, not authentication (spec 6.7 and 11, README Limitations), and on read the
// file must belong to the gateway's user with no group or other permission bits, as writeLkg creates it.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildBundle, serializeBundle } from '../../src/policy/bundle.js';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { LKG_FILE, readLkg, writeLkg } from '../../src/policy-loader/lkg.js';

const ROOT = join(import.meta.dirname, '..', '..');
let state: string;
let tmp: string;
beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ty-c10-')));
  state = join(tmp, 'state');
  const src = await loadPolicyDir(join(ROOT, 'examples/policy'), { root: ROOT });
  await writeLkg(state, serializeBundle(buildBundle(src, { createdAt: '2026-11-03T00:00:00.000Z' })));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test.skipIf(process.platform === 'win32')('C10 a last-known-good readable or writable by group or others is refused; 0600 is read', async () => {
  await expect(readLkg(state)).resolves.not.toBeNull();
  for (const mode of [0o644, 0o620, 0o602, 0o640]) {
    chmodSync(join(state, LKG_FILE), mode);
    await expect(readLkg(state)).rejects.toThrow(/permissions/);
  }
  chmodSync(join(state, LKG_FILE), 0o600);
  await expect(readLkg(state)).resolves.not.toBeNull();
});

test('C10 the sha256 is documented as corruption detection, not authentication', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const limitations = readme.slice(readme.indexOf('## Limitations'), readme.indexOf('## Development'));
  expect(limitations).toMatch(/last-known-good[^\n]*corruption/i);
  const spec = readFileSync(join(ROOT, 'docs/superpowers/specs/2026-11-02-gateway-design.md'), 'utf8');
  expect(spec.slice(spec.indexOf('### 6.7'), spec.indexOf('### 6.8'))).toMatch(/corruption/);
  expect(spec.slice(spec.indexOf('## 11.'), spec.indexOf('## 12.'))).toMatch(/last-known-good[^\n]*corruption/i);
  expect(readFileSync(join(ROOT, 'src/policy-loader/lkg.ts'), 'utf8')).not.toMatch(/tampered copy is refused/);
});
