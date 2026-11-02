// The one place a trace record (spec 9.1) is built from what a request knew at its end.
import { pseudonym } from '../guardrails/hmac.js';
import type { TraceRecord } from '../ledger/record.js';
import type { RequestOutcome } from './handler.js';

/** Client agent and version from the User-Agent header, best effort (spec 9.1). */
export function parseClient(userAgent: string | undefined): RequestOutcome['client'] {
  const ua = userAgent ?? '';
  const claude = /^claude-cli\/([^\s;()]+)/i.exec(ua);
  if (claude) return { agent: 'claude-code', version: claude[1] ?? null };
  const codex = /^codex[\w-]*\/([^\s;()]+)/i.exec(ua);
  if (codex) return { agent: 'codex', version: codex[1] ?? null };
  return { agent: 'other', version: null };
}

/**
 * Pseudonymises session, agent, parent agent and prompt id with `salt`; request class, agent type, repo, branch,
 * ticket and feature are short labels chosen by tooling, not content, and stay in clear (they are what reports group by).
 * Nothing from the request body is copied: only counts, sizes and the model name.
 */
export function buildTraceRecord(o: RequestOutcome, salt: string): Omit<TraceRecord, 'instance' | 'seq'> {
  const hmac = (v: string | null): string | null => (v === null ? null : pseudonym(salt, v));
  const u = o.usage;
  const a = o.attribution;
  return {
    v: 1,
    kind: 'request',
    id: o.id,
    ts: new Date(o.startedAt).toISOString(),
    tenant: o.key.tenant,
    team: o.key.team,
    keyId: o.key.keyId,
    traffic: o.key.kind === 'service' ? 'product' : 'coding-agent',
    billing: o.key.billing,
    surface: o.surface,
    client: o.client,
    attribution: {
      session: hmac(a.session),
      agent: hmac(a.agent),
      parentAgent: hmac(a.parentAgent),
      promptId: hmac(a.promptId),
      requestClass: a.requestClass,
      agentType: a.agentType,
      repo: a.repo,
      branch: a.branch,
      ticket: a.ticket,
      feature: a.feature,
      ...(a.sanitized ? { sanitized: true as const } : {}),
    },
    features: {
      model: o.features.model ?? u?.responseModel ?? '',
      stream: o.features.stream,
      // Exits before the decision have no bound: the body size stands in (at most one token per byte, spec 7.3).
      inputTokensBound: o.inputBound?.tokens ?? o.features.bodyBytes,
      boundKind: o.inputBound?.kind ?? 'bytes',
      maxOutputTokens: o.features.maxOutputTokens,
      serverTools: o.features.serverTools,
      toolCount: o.features.toolCount,
      thinking: o.features.thinking,
      bodyBytes: o.features.bodyBytes,
      prefixHash: o.features.prefixHash,
      contextCompacted: false,
    },
    guardrail: { hits: [] },
    policy: { revision: o.policyRevision, ...(o.candidate ? { candidateRevision: o.candidate.revision } : {}), ...(o.candidate && 'error' in o.candidate ? { candidateError: o.candidate.error } : {}) },
    decision: {
      route: o.route?.name ?? null,
      action: o.decision?.action ?? 'forward',
      reason: o.decision?.reason ?? null,
      chain: o.route ? [...o.route.chain] : [],
      reservedMicroUsd: 0,
      boundAssumed: o.boundAssumed ?? false,
      taintUnchecked: false,
      audit: [],
    },
    ...(o.candidate && !('error' in o.candidate)
      ? {
          candidateDecision: {
            route: o.candidate.route,
            action: o.candidate.action,
            reason: o.candidate.reason,
            chain: [...o.candidate.chain],
            reservedMicroUsd: 0,
            boundAssumed: false,
            taintUnchecked: false,
            audit: [],
          },
        }
      : {}),
    outcome: {
      provider: o.provider,
      upstreamModel: o.provider === null ? null : (u?.responseModel ?? o.features.model),
      attempts: o.attempts ?? 1,
      cacheColdRisk: o.cacheColdRisk ?? false,
      status: o.status,
      errorClass: o.errorClass ?? null,
      midStreamError: u?.midStreamError ?? null,
      ttfbMs: o.ttfbMs,
      totalMs: o.totalMs,
      addedTtfbMs: o.addedTtfbMs,
      usage: u?.usage ?? null,
      usageSource: u?.source ?? 'none',
      ...(u?.outputEstimated ? { outputEstimated: true } : {}),
      costMicroUsd: o.costMicroUsd,
      costBasis: o.costBasis,
      priceTable: o.priceTable,
      aborted: o.aborted,
      settledBy: 'request',
      overrun: false,
      ...(o.rateLimitHeaders && Object.keys(o.rateLimitHeaders).length > 0 ? { rateLimitHeaders: o.rateLimitHeaders } : {}),
    },
  };
}
