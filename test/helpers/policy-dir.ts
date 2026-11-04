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

/** The three files of a test policy, in the order they are written (policy.yaml last). */
const policyFiles = (upstream: string, name: string): Array<[string, string]> => [
  ['prices.yaml', read('prices.yaml')],
  ['keys.yaml', keysYaml()],
  ['policy.yaml', policyYaml(upstream, name)],
];

/** Writes the three files of a test policy into `dir`. Atomic per file (temp file and rename), like most editors. */
export function writePolicyDir(dir: string, upstream: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of policyFiles(upstream, name)) {
    const tmp = join(dir, `.${f}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, join(dir, f));
  }
}

/**
 * rename over an existing file, as an editor's atomic save does, for writes made while a loader in this process reads
 * the directory. On Windows a rename onto a file another handle has open fails with EPERM, EACCES or EBUSY until that
 * handle is closed; editors and graceful-fs retry, and so does this, for up to 2 s. The wait yields to the event loop,
 * so a read by this same process can finish and close its handle. Any other error, or one that persists, is thrown.
 */
export async function replaceFile(tmp: string, dest: string): Promise<void> {
  const until = Date.now() + 2_000;
  for (;;) {
    try {
      return renameSync(tmp, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code) || Date.now() > until) throw e;
      await sleep(10);
    }
  }
}

/** writePolicyDir for a directory a loader in this process is watching (renames through replaceFile). */
export async function rewritePolicyDir(dir: string, upstream: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of policyFiles(upstream, name)) {
    const tmp = join(dir, `.${f}.tmp`);
    writeFileSync(tmp, text);
    await replaceFile(tmp, join(dir, f));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
