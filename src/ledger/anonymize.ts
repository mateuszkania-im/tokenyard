import { pseudonym } from '../guardrails/hmac.js';
import { errorCodeLabel, INVALID_TOOL_TYPE, modelShapeLabel, rateLimitHeadersLabel, serviceTierLabel, toolTypeLabel } from '../surfaces/labels.js';
import type { TraceRecord } from './record.js';

export type PseudonymKind =
  | 'tenant' | 'team' | 'key' | 'repo' | 'branch' | 'ticket' | 'feature' | 'agentType' | 'requestClass'
  // Linkable ids: already hashes or HMACs in the raw traces, but stable across exports and, for prefixHash, an unsalted
  // SHA-256 of the tools and system bytes that anyone holding those bytes can confirm. Re-keyed with the export salt.
  | 'prefix' | 'session' | 'agent' | 'promptId' | 'valueHmac' | 'instance'
  // A model name the gateway pseudonymised (B1), or a name a trace written before that holds in an unexpected shape.
  | 'model'
  // A server tool type not shaped like one (S-V4-2): a token or hex string a client put in `tools[].type`.
  | 'toolType';

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
const MODEL_PSEUDONYM = /^model-[0-9a-f]{16}$/;

/**
 * The shape of real server tool types: lowercase words joined by `_`, optionally ending in a date (`web_search_20250305`,
 * `file_search`, `mcp`). The ingest bound (`[a-z0-9_]`) also lets lowercase tokens and hex secrets through (S-V4-2).
 */
const TOOL_TYPE_WORDS = /^[a-z]+(?:_[a-z]+)*(?:_\d{8})?$/;

/** A tool type as exported: kept when shaped like one, else pseudonymised; an unknown type stays unpriced in replay. */
function exportedToolType(type: string, p: (kind: PseudonymKind, v: string) => string): string {
  const t = toolTypeLabel(type);
  return t === INVALID_TOOL_TYPE || TOOL_TYPE_WORDS.test(t) ? t : p('toolType', t);
}

/**
 * The model as exported: the gateway writes a name in clear only when it is priced or a wildcard-free allowModels
 * entry, and a trace-salted `model-<hex>` otherwise; that pseudonym is re-keyed with the export salt, and so is any name
 * not shaped like a model id (traces written before B1). The empty string and `other` stay.
 */
function exportedModel(m: string, p: (kind: PseudonymKind, v: string) => string): string {
  if (m === '' || m === 'other') return m;
  return MODEL_PSEUDONYM.test(m) || modelShapeLabel(m) !== m ? p('model', m) : m;
}

export function anonymizeRecord(r: TraceRecord, p: (kind: PseudonymKind, v: string) => string): TraceRecord {
  const opt = (kind: PseudonymKind, v: string | null): string | null => (v === null ? null : p(kind, v));
  const enumOr = (kind: PseudonymKind, v: string | null, known: ReadonlySet<string>): string | null =>
    v === null || known.has(v) ? v : p(kind, v);
  const a = r.attribution;
  const f = r.features;
  const o = r.outcome;
  // Every object is rebuilt field by field (B1): a key this code does not name never reaches an export, and free text a
  // client or upstream chose (model, tool type, service tier, error code) is bounded again, for traces written before
  // the gateway bounded it at ingest.
  const tenant = p('tenant', r.tenant);
  const team = opt('team', r.team);
  const keyId = p('key', r.keyId);
  const instance = p('instance', r.instance);
  return {
    v: r.v,
    kind: r.kind,
    id: r.id,
    ts: r.ts,
    instance,
    seq: r.seq,
    tenant,
    team,
    keyId,
    traffic: r.traffic,
    billing: r.billing,
    surface: r.surface,
    client: { agent: r.client.agent, version: null },
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
    features: {
      model: exportedModel(f.model, p),
      ...(f.modelGlobs ? { modelGlobs: [...f.modelGlobs] } : {}),
      stream: f.stream,
      inputTokensBound: f.inputTokensBound,
      boundKind: f.boundKind,
      maxOutputTokens: f.maxOutputTokens,
      serverTools: f.serverTools.map((t) => ({ type: exportedToolType(t.type, p), maxUses: t.maxUses })),
      toolCount: f.toolCount,
      thinking: f.thinking,
      bodyBytes: f.bodyBytes,
      prefixHash: opt('prefix', f.prefixHash),
      contextCompacted: f.contextCompacted,
      ...(f.fastMode ? { fastMode: true as const } : {}),
      ...(f.compaction ? { compaction: true as const } : {}),
      ...(f.serviceTier !== undefined ? { serviceTier: serviceTierLabel(f.serviceTier) } : {}),
    },
    guardrail: { hits: r.guardrail.hits.map((h) => ({ rule: h.rule, action: h.action, valueHmac: p('valueHmac', h.valueHmac), where: h.where })) },
    policy: {
      revision: r.policy.revision,
      ...(r.policy.candidateRevision !== undefined ? { candidateRevision: r.policy.candidateRevision } : {}),
      ...(r.policy.candidateError !== undefined ? { candidateError: r.policy.candidateError } : {}),
    },
    decision: decisionOf(r.decision),
    ...(r.candidateDecision ? { candidateDecision: decisionOf(r.candidateDecision) } : {}),
    outcome: {
      provider: o.provider,
      upstreamModel: o.upstreamModel === null ? null : exportedModel(o.upstreamModel, p),
      attempts: o.attempts,
      cacheColdRisk: o.cacheColdRisk,
      status: o.status,
      errorClass: o.errorClass === null ? null : errorCodeLabel(o.errorClass),
      midStreamError: o.midStreamError === null ? null : errorCodeLabel(o.midStreamError),
      ttfbMs: o.ttfbMs,
      totalMs: o.totalMs,
      addedTtfbMs: o.addedTtfbMs,
      usage: o.usage === null ? null : { input: o.usage.input, output: o.usage.output, cacheRead: o.usage.cacheRead, cacheWrite5m: o.usage.cacheWrite5m, cacheWrite1h: o.usage.cacheWrite1h },
      usageSource: o.usageSource,
      ...(o.outputEstimated !== undefined ? { outputEstimated: o.outputEstimated } : {}),
      costMicroUsd: o.costMicroUsd,
      costBasis: o.costBasis,
      priceTable: o.priceTable,
      ...(o.fast ? { fast: true as const } : {}),
      ...(o.serviceTier !== undefined ? { serviceTier: serviceTierLabel(o.serviceTier) } : {}),
      ...(o.modifiers ? { modifiers: [...o.modifiers] } : {}),
      ...(o.serverToolUses ? { serverToolUses: { ...o.serverToolUses } } : {}),
      aborted: o.aborted,
      settledBy: o.settledBy,
      ...(o.settleSeq !== undefined ? { settleSeq: o.settleSeq } : {}),
      overrun: o.overrun,
      ...(o.settledAtEstimate ? { settledAtEstimate: true as const } : {}),
      ...(o.chargedMicroUsd !== undefined ? { chargedMicroUsd: o.chargedMicroUsd } : {}),
      ...(o.boundExceeded ? { boundExceeded: true as const } : {}),
      ...(o.rateLimitHeaders ? { rateLimitHeaders: rateLimitHeadersLabel(o.rateLimitHeaders) } : {}),
    },
  };
}

function decisionOf(d: TraceRecord['decision']): TraceRecord['decision'] {
  return {
    route: d.route,
    action: d.action,
    reason: d.reason,
    chain: [...d.chain],
    reservedMicroUsd: d.reservedMicroUsd,
    boundAssumed: d.boundAssumed,
    taintUnchecked: d.taintUnchecked,
    audit: d.audit.map((x) => ({ name: x.name, wouldFail: x.wouldFail })),
    ...(d.storeDown ? { storeDown: true as const } : {}),
    ...(d.preDecision ? { preDecision: true as const } : {}),
    ...(d.admitOffsetMs !== undefined ? { admitOffsetMs: d.admitOffsetMs } : {}),
    ...(d.admitSeq !== undefined ? { admitSeq: d.admitSeq } : {}),
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
