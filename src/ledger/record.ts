// Spec 9.1 and 9.5: the trace record and the other lines of a ledger file. Types only.

export interface TraceRecord {
  v: 1;
  kind: 'request';
  id: string; ts: string;                        // request start, ISO
  instance: string; seq: number;                 // writer instance and its record sequence number
  tenant: string; team: string | null; keyId: string;   // config names and opaque key id, in clear
  traffic: 'coding-agent' | 'product'; billing: 'api' | 'subscription'; surface: string;
  client: { agent: 'claude-code' | 'codex' | 'other'; version: string | null };   // from User-Agent, best effort
  attribution: {                                 // session, agent, parentAgent, promptId: HMAC-SHA256 with a per-deployment salt
    session: string | null; agent: string | null; parentAgent: string | null; promptId: string | null;
    requestClass: string | null; agentType: string | null;
    repo: string | null; branch: string | null; ticket: string | null; feature: string | null;
    /** Not in spec 9.1: true when a client header value was cut or had non-printable or non-ASCII characters dropped at ingest. */
    sanitized?: true;
  };
  features: { model: string; stream: boolean; inputTokensBound: number; boundKind: 'bytes' | 'context-window';
              maxOutputTokens: number | null; serverTools: Array<{ type: string; maxUses: number | null }>;
              toolCount: number; thinking: boolean; bodyBytes: number; prefixHash: string | null;
              contextCompacted: boolean;
              /** Not in spec 9.1: set (true) when the body selected fast mode; the reservation is priced at fast rates (replay reproduces it). */
              fastMode?: true;
              /** Not in spec 9.1: set (true) when the body enabled threshold compaction; the reservation counts its iterations (replay reproduces it). */
              compaction?: true;
              /** Not in spec 9.1: the OpenAI service_tier the request asked for, when not default (replay prices the reservation with it). */
              serviceTier?: string;
              /** Not in spec 9.1: when `model` is a pseudonym (B1), the policy's model patterns (regex sources) the clear name matched; replay applies route conditions and allowlists with them. */
              modelGlobs?: string[] };
  guardrail: { hits: Array<{ rule: string; action: 'block' | 'warn' | 'redact'; valueHmac: string; where: 'last-turn' | 'history' }> };
  policy: { revision: string; candidateRevision?: string; candidateError?: string };
  decision: { route: string | null; action: 'forward' | 'block'; reason: string | null;
              chain: string[]; reservedMicroUsd: number; boundAssumed: boolean; taintUnchecked: boolean;
              audit: Array<{ name: string; wouldFail: boolean }>;
              /** Not in spec 9.1: set (true) when admit could not reach the counter store and failure.counterStoreDown applied. */
              storeDown?: true;
              /** Not in spec 9.1: set (true) when the request ended before a decision (body too large, client gone while uploading, reservation not computable); replay skips it. */
              preDecision?: true;
              /** Not in spec 9.1: ms after the request started when admit was called (absent when it was not). Replay admits at ts plus this. */
              admitOffsetMs?: number;
              /** Not in spec 9.1: the writer instance's admit call number, which orders admits within one millisecond. */
              admitSeq?: number };
  candidateDecision?: TraceRecord['decision'];
  outcome: {
    provider: string | null; upstreamModel: string | null; attempts: number; cacheColdRisk: boolean;
    status: number; errorClass: string | null; midStreamError: string | null;
    ttfbMs: number | null; totalMs: number; addedTtfbMs: number | null;
    usage: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null;
    usageSource: 'final' | 'partial' | 'estimated' | 'none';
    /** Set (true) when usageSource is 'final' but `usage.output` was estimated from streamed characters: message_stop arrived without a message_delta output count. Not in spec 9.1; added so settlement and replay can tell. */
    outputEstimated?: boolean;
    costMicroUsd: number | null; costBasis: 'billed' | 'api-equivalent'; priceTable: string;
    /** Not in spec 9.1: the cost was priced at fast mode rates (response or request). Replay reprices with it. */
    fast?: true;
    /** Not in spec 9.1: the OpenAI service tier the cost was priced at, when not default (replay reprices with it). */
    serviceTier?: string;
    /** Not in spec 9.1: price table modifiers the request selected (for example `inferenceGeoUs`). Absent when none. */
    modifiers?: string[];
    /** Not in spec 9.1: server tool uses by price table tool name, as billed. Absent when none. */
    serverToolUses?: Record<string, number>;
    aborted: boolean; settledBy: 'request' | 'sweeper'; overrun: boolean;
    /** Not in spec 9.1: set (true) when the actual cost could not be computed and the reservation estimate was settled instead; `costMicroUsd` is that estimate. */
    settledAtEstimate?: true;
    /** Not in spec 9.1: what the counter store charged the budget levels at settlement (the estimate when the sweeper settled it); absent when nothing was reserved. Warm-up seeds this. */
    chargedMicroUsd?: number;
    /** Not in spec 9.1: set (true) when the billed input exceeded `features.inputTokensBound` of a bytes bound (R11); the bytes bound is off from then on. */
    boundExceeded?: true;
    rateLimitHeaders?: Record<string, string>;   // anthropic-ratelimit-unified-* only
  };
}

/** First line of every ledger file (spec 9.1). `firstSeq` is the seq the next request record of this instance will get. */
export interface SegmentRecord { v: 1; kind: 'segment'; instance: string; startedAt: string; firstSeq: number }
/** Appended every 60 s to each open file; `seq` is the last request seq assigned, so a tail of dropped records shows. */
export interface HeartbeatRecord { v: 1; kind: 'heartbeat'; instance: string; ts: string; seq: number }
/** Appended on graceful stop. */
export interface ShutdownRecord { v: 1; kind: 'shutdown'; instance: string; ts: string; seq: number }
/** First line of an export (spec 9.5). `hoursWithoutFile` lists UTC hours as `YYYY-MM-DDTHH`. */
export interface ManifestRecord {
  v: 1;
  kind: 'manifest';
  since: string;
  until: string;
  instances: Array<{ id: string; firstTs: string; lastTs: string; records: number; seqGaps: number; hoursWithoutFile: string[];
    /** Not in spec 9.5: the instance's latest line is a shutdown record (a graceful stop). Absent in older exports. */
    shutdown?: boolean }>;
}
/**
 * Not in spec 9.1: a write-ahead line queued when a request is admitted (live harness, A11), before the upstream is
 * called. Warm-up counts `reservedMicroUsd` on the request's budget levels until a request line with the same `id`
 * appears, so a request in flight when the process dies is still counted by the next run. Scope fields as on the
 * request line (session pseudonymised); no content.
 */
export interface ReservedRecord {
  v: 1;
  kind: 'reserved';
  instance: string;
  id: string;
  ts: string;
  tenant: string;
  team: string | null;
  keyId: string;
  billing: 'api' | 'subscription';
  attribution: { repo: string | null; session: string | null };
  reservedMicroUsd: number;
}

export type LedgerLine = TraceRecord | SegmentRecord | HeartbeatRecord | ShutdownRecord | ManifestRecord | ReservedRecord;
