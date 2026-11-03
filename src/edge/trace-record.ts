// The one place a trace record (spec 9.1) is built from what a request knew at its end.
import { pseudonym } from '../guardrails/hmac.js';
import { billedServiceTier } from '../pricing/cost.js';
import { lookupModel } from '../pricing/prices.js';
import { globTest } from '../policy/match.js';
import type { CompiledPolicy } from '../policy/types.js';
import type { TraceRecord } from '../ledger/record.js';
import { sanitizeHeaderValue } from '../report/sanitize.js';
import { errorCodeLabel, modelShapeLabel, OTHER, rateLimitHeadersLabel, serviceTierLabel } from '../surfaces/labels.js';
import type { RequestOutcome } from './handler.js';

/** Client agent and version from the User-Agent header, best effort (spec 9.1). */
export function parseClient(userAgent: string | undefined): RequestOutcome['client'] {
  const ua = userAgent ?? '';
  // The version is client free text: printable ASCII, at most 128 characters, like every header label (B1).
  const version = (v: string | undefined): string | null => (v === undefined ? null : sanitizeHeaderValue(v).value || null);
  const claude = /^claude-cli\/([^\s;()]+)/i.exec(ua);
  if (claude) return { agent: 'claude-code', version: version(claude[1]) };
  const codex = /^codex[\w-]*\/([^\s;()]+)/i.exec(ua);
  if (codex) return { agent: 'codex', version: version(codex[1]) };
  return { agent: 'other', version: null };
}

/** The policy parts that say which model names a trace may hold. */
export type ModelNames = Pick<CompiledPolicy, 'prices' | 'routes'>;

/**
 * The model as traced (B1), so a secret or prose pasted into `model` never reaches a trace, span or export: kept when
 * the price table prices it, or when it has the shape of a model id (lowercase, at most 64 characters) and an explicit
 * `allowModels` pattern of a route matches it (an operator-listed name the price table does not know yet, which replay
 * needs to reproduce the route's allowlist); any other name is `other`. No model stays the empty string.
 */
export function tracedModel(p: ModelNames, model: string | null | undefined): string {
  if (!model) return '';
  if (lookupModel(p.prices, model) !== null) return model;
  const listed = modelShapeLabel(model) === model && p.routes.some((r) => r.allowModels !== null && r.allowModels.some((re) => globTest(re, model)));
  return listed ? model : OTHER;
}



/**
 * Pseudonymises session, agent, parent agent and prompt id with `salt`; request class, agent type, repo, branch,
 * ticket and feature are short labels chosen by tooling, not content, and stay in clear (they are what reports group by).
 * Nothing from the request body is copied: only counts, sizes, the model name as `tracedModel` bounds it,
 * server tool types and the service tier, both bounded at extraction.
 */
export function buildTraceRecord(o: RequestOutcome, salt: string, names: ModelNames): Omit<TraceRecord, 'instance' | 'seq'> {
  const hmac = (v: string | null): string | null => (v === null ? null : pseudonym(salt, v));
  const u = o.usage;
  const a = o.attribution;
  const rateLimit = rateLimitHeadersLabel(o.rateLimitHeaders ?? {});
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
      model: tracedModel(names, o.features.model ?? u?.responseModel),
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
      ...(o.features.fastMode ? { fastMode: true as const } : {}),
      ...(o.features.compaction ? { compaction: true as const } : {}),
      ...(o.features.serviceTier !== undefined ? { serviceTier: o.features.serviceTier } : {}),
    },
    // The message index stays out: it is for the error message only.
    guardrail: { hits: (o.guardrailHits ?? []).map((h) => ({ rule: h.rule, action: h.action, valueHmac: h.valueHmac, where: h.where })) },
    policy: { revision: o.policyRevision, ...(o.candidate ? { candidateRevision: o.candidate.revision } : {}), ...(o.candidate && 'error' in o.candidate ? { candidateError: o.candidate.error } : {}) },
    decision: {
      route: o.route?.name ?? null,
      action: o.decision?.action ?? 'forward',
      reason: o.decision?.reason ?? null,
      chain: o.route ? [...o.route.chain] : [],
      reservedMicroUsd: o.reservedMicroUsd ?? 0,
      boundAssumed: o.boundAssumed ?? false,
      taintUnchecked: o.taintUnchecked ?? false,
      audit: o.audit ? o.audit.map((a) => ({ ...a })) : [],
      ...(o.storeDown ? { storeDown: true as const } : {}),
      // Every exit after decide carries the bound it used; without one there was no plan to replay.
      ...(o.inputBound === undefined ? { preDecision: true as const } : {}),
      ...(o.admitAt ? { admitOffsetMs: o.admitAt.offsetMs, admitSeq: o.admitAt.seq } : {}),
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
      upstreamModel: o.provider === null ? null : tracedModel(names, u?.responseModel ?? o.features.model),
      attempts: o.attempts ?? 1,
      cacheColdRisk: o.cacheColdRisk ?? false,
      status: o.status,
      errorClass: o.errorClass ?? null,
      midStreamError: u?.midStreamError ? errorCodeLabel(u.midStreamError) : null,
      ttfbMs: o.ttfbMs,
      totalMs: o.totalMs,
      addedTtfbMs: o.addedTtfbMs,
      usage: u?.usage ?? null,
      usageSource: u?.source ?? 'none',
      ...(u?.outputEstimated ? { outputEstimated: true } : {}),
      costMicroUsd: o.costMicroUsd,
      costBasis: o.costBasis,
      priceTable: o.priceTable,
      ...(u?.usage && (u.fast === true || o.features.fastMode) ? { fast: true as const } : {}),
      ...(u?.usage && billedServiceTier(u, o.features) !== undefined ? { serviceTier: serviceTierLabel(billedServiceTier(u, o.features) as string) } : {}),
      ...(o.costModifiers && o.costModifiers.length > 0 ? { modifiers: [...o.costModifiers] } : {}),
      ...(u?.serverToolUses && Object.keys(u.serverToolUses).length > 0 ? { serverToolUses: { ...u.serverToolUses } } : {}),
      aborted: o.aborted,
      settledBy: o.settledBy ?? 'request',
      overrun: o.overrun ?? false,
      ...(o.settledAtEstimate ? { settledAtEstimate: true as const } : {}),
      ...(o.boundExceeded ? { boundExceeded: true as const } : {}),
      ...(o.chargedMicroUsd !== undefined ? { chargedMicroUsd: o.chargedMicroUsd } : {}),
      ...(Object.keys(rateLimit).length > 0 ? { rateLimitHeaders: rateLimit } : {}),
    },
  };
}
