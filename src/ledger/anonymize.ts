import { pseudonym } from '../guardrails/hmac.js';
import type { TraceRecord } from './record.js';

export type PseudonymKind = 'tenant' | 'team' | 'key' | 'repo' | 'branch' | 'ticket' | 'feature' | 'agentType' | 'requestClass';

/** Fixed values Claude Code sends as request class (spec 5.4); anything else is free text from a header. */
const REQUEST_CLASSES: ReadonlySet<string> = new Set(['main', 'subagent', 'compaction', 'auxiliary']);
/** Built-in Claude Code agent types. A custom agent type is a user-chosen name, so it is pseudonymised. */
const AGENT_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide']);

/**
 * Deny by default (spec 9.5): tenant, team, key id, repo, branch, ticket, feature and every attribution label that is
 * not a fixed enum value are replaced by the pseudonyms `p` returns; `client.version` is dropped. The attribution
 * object is rebuilt field by field, so an unknown key never survives. Session, agent, parent agent and prompt id
 * are already HMACs.
 */
export function anonymizeRecord(r: TraceRecord, p: (kind: PseudonymKind, v: string) => string): TraceRecord {
  const opt = (kind: PseudonymKind, v: string | null): string | null => (v === null ? null : p(kind, v));
  const enumOr = (kind: PseudonymKind, v: string | null, known: ReadonlySet<string>): string | null =>
    v === null || known.has(v) ? v : p(kind, v);
  const a = r.attribution;
  return {
    ...r,
    tenant: p('tenant', r.tenant),
    team: opt('team', r.team),
    keyId: p('key', r.keyId),
    client: { ...r.client, version: null },
    attribution: {
      session: a.session,
      agent: a.agent,
      parentAgent: a.parentAgent,
      promptId: a.promptId,
      requestClass: enumOr('requestClass', a.requestClass, REQUEST_CLASSES),
      agentType: enumOr('agentType', a.agentType, AGENT_TYPES),
      repo: opt('repo', a.repo),
      branch: opt('branch', a.branch),
      ticket: opt('ticket', a.ticket),
      feature: opt('feature', a.feature),
      ...(a.sanitized ? { sanitized: true as const } : {}),
    },
  };
}

/** Stable across exports for one salt: `tenant-1a2b3c4d`. Different salts give unrelated names. */
export function saltedPseudonyms(salt: string): (kind: PseudonymKind, v: string) => string {
  return (kind, v) => `${kind}-${pseudonym(salt, `${kind}:${v}`).slice(0, 8)}`;
}
