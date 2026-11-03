import { pseudonym } from '../guardrails/hmac.js';
import type { TraceRecord } from './record.js';

export type PseudonymKind =
  | 'tenant' | 'team' | 'key' | 'repo' | 'branch' | 'ticket' | 'feature' | 'agentType' | 'requestClass'
  // Linkable ids: already hashes or HMACs in the raw traces, but stable across exports and, for prefixHash, an unsalted
  // SHA-256 of the tools and system bytes that anyone holding those bytes can confirm. Re-keyed with the export salt.
  | 'prefix' | 'session' | 'agent' | 'promptId' | 'valueHmac' | 'instance';

/** Kinds whose pseudonym keeps the hex shape of the value it replaces (reports and replay treat them as opaque ids). */
const HEX_KINDS: ReadonlySet<PseudonymKind> = new Set(['prefix', 'session', 'agent', 'promptId', 'valueHmac']);

/** Fixed values Claude Code sends as request class (spec 5.4); anything else is free text from a header. */
const REQUEST_CLASSES: ReadonlySet<string> = new Set(['main', 'subagent', 'compaction', 'auxiliary']);
/** Built-in Claude Code agent types. A custom agent type is a user-chosen name, so it is pseudonymised. */
const AGENT_TYPES: ReadonlySet<string> = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide']);

/**
 * Deny by default (spec 9.5): tenant, team, key id, repo, branch, ticket, feature and every attribution label that is
 * not a fixed enum value are replaced by the pseudonyms `p` returns; `client.version` is dropped. The attribution
 * object is rebuilt field by field, so an unknown key never survives. Every linkable id is re-keyed too: session,
 * agent, parent agent and prompt id HMACs, the prefix hash, guardrail value HMACs and the instance id, each through
 * `p`, so equality within one export (sessions, subagent joins, cache breakers, taint) survives while nothing links
 * back to the raw traces or across exports with different salts. Agent and parent agent share one kind, so a
 * subagent still joins its parent. The record id is the caller's (export numbers records in export order).
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
    instance: p('instance', r.instance),
    attribution: {
      session: opt('session', a.session),
      agent: opt('agent', a.agent),
      parentAgent: opt('agent', a.parentAgent),
      promptId: opt('promptId', a.promptId),
      requestClass: enumOr('requestClass', a.requestClass, REQUEST_CLASSES),
      agentType: enumOr('agentType', a.agentType, AGENT_TYPES),
      repo: opt('repo', a.repo),
      branch: opt('branch', a.branch),
      ticket: opt('ticket', a.ticket),
      feature: opt('feature', a.feature),
      ...(a.sanitized ? { sanitized: true as const } : {}),
    },
    features: { ...r.features, prefixHash: opt('prefix', r.features.prefixHash) },
    guardrail: { hits: r.guardrail.hits.map((h) => ({ ...h, valueHmac: p('valueHmac', h.valueHmac) })) },
  };
}

/**
 * Stable across exports for one salt: `tenant-1a2b3c4d`; ids keep a hex shape (32 hex characters; the instance 8).
 * Different salts give unrelated values.
 */
export function saltedPseudonyms(salt: string): (kind: PseudonymKind, v: string) => string {
  return (kind, v) => {
    const h = pseudonym(salt, `${kind}:${v}`);
    if (HEX_KINDS.has(kind)) return h;
    if (kind === 'instance') return h.slice(0, 8);
    return `${kind}-${h.slice(0, 8)}`;
  };
}
