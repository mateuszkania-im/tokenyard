// HMAC-SHA256 pseudonyms (spec 9.1, 11): ids that leave the gateway in traces are salted, never raw.
import { createHmac } from 'node:crypto';

/** First 32 hex characters of HMAC-SHA256(salt, value): stable per salt, not reversible without it. */
export function pseudonym(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 32);
}

/**
 * The key of guardrail value HMACs (session taint, trace hits), derived from the trace salt as HMAC(traceSalt,
 * "guardrail") (B8): instances sharing a trace salt share taint, while pseudonyms and value HMACs never share a key, so
 * the trace salt alone does not confirm a guessed secret value.
 */
export function guardrailKey(traceSalt: string): string {
  return createHmac('sha256', traceSalt).update('guardrail').digest('hex');
}
