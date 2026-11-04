import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashKey } from '../../src/edge/auth.js';
import { PROVIDER_KEY_ENV, TEST_KEY } from './policy.js';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'policy');
const read = (f: string): string => readFileSync(join(EXAMPLE, f), 'utf8');

export const tempDir = (prefix = 'ty-'): string => mkdtempSync(join(tmpdir(), prefix));

/** policy.yaml text of examples/policy pointed at `upstream`, with `name` as metadata.name so each variant has its own sha256. */
export function policyYaml(upstream: string, name: string): string {
  return read('policy.yaml')
    .replaceAll('https://api.anthropic.com', upstream)
    .replaceAll('ANTHROPIC_API_KEY_BACKUP', PROVIDER_KEY_ENV)
    .replaceAll('ANTHROPIC_API_KEY', PROVIDER_KEY_ENV)
    .replace('name: acme-coding-agents', `name: ${name}`);
}

export const keysYaml = (): string =>
  `- {"hash":"${hashKey(TEST_KEY)}","keyId":"key_test","tenant":"acme","team":"platform","name":"test","kind":"developer","billing":"api"}\n`;

/**
 * renameSync over an existing file, as an editor's atomic save does. On Windows a rename onto a file that another
 * handle has open (the loader reading it, an indexer, antivirus) fails with EPERM, EACCES or EBUSY for a moment;
 * editors and graceful-fs retry, and so does this, for up to 2 s. Any other error, or one that persists, is thrown.
 */
export function replaceFileSync(tmp: string, dest: string): void {
  const until = Date.now() + 2_000;
  for (;;) {
    try {
      return renameSync(tmp, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || Date.now() > until) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** Writes the three files of a test policy into `dir`. Atomic per file (temp file and rename), like most editors. */
export function writePolicyDir(dir: string, upstream: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const put = (f: string, text: string): void => {
    const tmp = join(dir, `.${f}.tmp`);
    writeFileSync(tmp, text);
    replaceFileSync(tmp, join(dir, f));
  };
  put('prices.yaml', read('prices.yaml'));
  put('keys.yaml', keysYaml());
  put('policy.yaml', policyYaml(upstream, name));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
