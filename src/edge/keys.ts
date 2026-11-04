import { randomBytes } from 'node:crypto';
import { cliRoot, writeFileUnder } from '../fsutil/safe-path.js';
import type { KeyRecord } from '../policy/types.js';
import { hashKey } from './auth.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const B62_LEN = 43; // 62^43 > 2^256 > 62^42

function base62(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = B62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(B62_LEN, '0');
}

/** A new key: `ty_live_` plus base62 of 32 random bytes. The plaintext is shown once; only the SHA-256 hash is stored. */
export function createKey(): { plaintext: string; hash: string } {
  const plaintext = `ty_live_${base62(randomBytes(32))}`;
  return { plaintext, hash: hashKey(plaintext) };
}

/**
 * Appends one record to a YAML list file (creating it). Each record is one flow mapping line; JSON is valid YAML flow.
 * Never through a symbolic link (S-FS-1).
 */
export async function appendKey(file: string, rec: KeyRecord): Promise<void> {
  await writeFileUnder(cliRoot(file), file, `- ${JSON.stringify(rec)}\n`, { append: true });
}
