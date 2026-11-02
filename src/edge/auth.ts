import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type CredentialSource = 'x-tokenyard-key' | 'bearer' | 'x-api-key';

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export interface Credential {
  source: CredentialSource;
  value: string;
}

/** Every credential the request carries, in precedence order: `x-tokenyard-key`, `Authorization: Bearer`, `x-api-key` (spec 5.3 step 2). */
export function extractCredentials(h: IncomingHttpHeaders): Credential[] {
  const out: Credential[] = [];
  const own = first(h['x-tokenyard-key'])?.trim();
  if (own) out.push({ source: 'x-tokenyard-key', value: own });
  const bearer = /^bearer\s+(.+)$/i.exec(first(h.authorization)?.trim() ?? '')?.[1]?.trim();
  if (bearer) out.push({ source: 'bearer', value: bearer });
  const apiKey = first(h['x-api-key'])?.trim();
  if (apiKey) out.push({ source: 'x-api-key', value: apiKey });
  return out;
}

/** The first credential in precedence order. */
export function extractCredential(h: IncomingHttpHeaders): Credential | null {
  return extractCredentials(h)[0] ?? null;
}

/** SHA-256 hex of a key; the key map is keyed by this hash, never by the plaintext. */
export function hashKey(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}
