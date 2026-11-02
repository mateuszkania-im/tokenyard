import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type CredentialSource = 'x-tokenyard-key' | 'bearer' | 'x-api-key';

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The tokenyard key: `x-tokenyard-key`, then `Authorization: Bearer`, then `x-api-key` (spec 5.3 step 2). */
export function extractCredential(h: IncomingHttpHeaders): { source: CredentialSource; value: string } | null {
  const own = first(h['x-tokenyard-key'])?.trim();
  if (own) return { source: 'x-tokenyard-key', value: own };
  const bearer = /^bearer\s+(.+)$/i.exec(first(h.authorization)?.trim() ?? '')?.[1]?.trim();
  if (bearer) return { source: 'bearer', value: bearer };
  const apiKey = first(h['x-api-key'])?.trim();
  if (apiKey) return { source: 'x-api-key', value: apiKey };
  return null;
}

/** SHA-256 hex of a key; the key map is keyed by this hash, never by the plaintext. */
export function hashKey(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}
