// HMAC-SHA256 pseudonyms (spec 9.1, 11): ids that leave the gateway in traces are salted, never raw.
import { createHmac } from 'node:crypto';

/** First 32 hex characters of HMAC-SHA256(salt, value): stable per salt, not reversible without it. */
export function pseudonym(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 32);
}
