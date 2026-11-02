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

/** Writes the three files of a test policy into `dir`. Atomic per file (temp file and rename), like most editors. */
export function writePolicyDir(dir: string, upstream: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const put = (f: string, text: string): void => {
    const tmp = join(dir, `.${f}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, join(dir, f));
  };
  put('prices.yaml', read('prices.yaml'));
  put('keys.yaml', keysYaml());
  put('policy.yaml', policyYaml(upstream, name));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
