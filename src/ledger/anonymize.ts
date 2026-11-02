import { pseudonym } from '../guardrails/hmac.js';
import type { TraceRecord } from './record.js';

export type PseudonymKind = 'tenant' | 'team' | 'key' | 'repo' | 'branch' | 'ticket';

/**
 * Replaces tenant, team, key id, repo, branch and ticket with the pseudonyms `p` returns and drops `client.version`
 * (spec 9.5). Session, agent, parent agent and prompt ids are already HMACs; other fields hold no identifying text.
 */
export function anonymizeRecord(r: TraceRecord, p: (kind: PseudonymKind, v: string) => string): TraceRecord {
  const opt = (kind: PseudonymKind, v: string | null): string | null => (v === null ? null : p(kind, v));
  return {
    ...r,
    tenant: p('tenant', r.tenant),
    team: opt('team', r.team),
    keyId: p('key', r.keyId),
    client: { ...r.client, version: null },
    attribution: {
      ...r.attribution,
      repo: opt('repo', r.attribution.repo),
      branch: opt('branch', r.attribution.branch),
      ticket: opt('ticket', r.attribution.ticket),
    },
  };
}

/** Stable across exports for one salt: `tenant-1a2b3c4d`. Different salts give unrelated names. */
export function saltedPseudonyms(salt: string): (kind: PseudonymKind, v: string) => string {
  return (kind, v) => `${kind}-${pseudonym(salt, `${kind}:${v}`).slice(0, 8)}`;
}
