// Spec 9.1 trace record (type only). Task 7 adds the writer, reader and segment/heartbeat records.

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
  };
  features: { model: string; stream: boolean; inputTokensBound: number; boundKind: 'bytes' | 'context-window';
              maxOutputTokens: number | null; serverTools: Array<{ type: string; maxUses: number | null }>;
              toolCount: number; thinking: boolean; bodyBytes: number; prefixHash: string | null;
              contextCompacted: boolean };
  guardrail: { hits: Array<{ rule: string; action: 'block' | 'warn' | 'redact'; valueHmac: string; where: 'last-turn' | 'history' }> };
  policy: { revision: string; candidateRevision?: string };
  decision: { route: string | null; action: 'forward' | 'block'; reason: string | null;
              chain: string[]; reservedMicroUsd: number; boundAssumed: boolean; taintUnchecked: boolean;
              audit: Array<{ name: string; wouldFail: boolean }> };
  candidateDecision?: TraceRecord['decision'];
  outcome: {
    provider: string | null; upstreamModel: string | null; attempts: number; cacheColdRisk: boolean;
    status: number; errorClass: string | null; midStreamError: string | null;
    ttfbMs: number | null; totalMs: number; addedTtfbMs: number | null;
    usage: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null;
    usageSource: 'final' | 'partial' | 'estimated' | 'none';
    costMicroUsd: number | null; costBasis: 'billed' | 'api-equivalent'; priceTable: string;
    aborted: boolean; settledBy: 'request' | 'sweeper'; overrun: boolean;
    rateLimitHeaders?: Record<string, string>;   // anthropic-ratelimit-unified-* only
  };
}
