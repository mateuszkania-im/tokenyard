// OTel GenAI spans (spec 12.2). The OpenTelemetry packages are imported only when an endpoint is set, so a gateway
// without OTLP loads none of them. Spans carry what the trace record carries (pseudonymised ids, names from the policy,
// counts, timings) and never prompt text, tool content, file paths or credentials: content attributes are never set.
import type { TraceRecord } from '../ledger/record.js';
import { sanitizeHeaderValue } from '../report/sanitize.js';
import type { AttemptInfo } from '../upstream/chain.js';
import { GEN_AI, TOKENYARD } from './semconv.js';

export type { AttemptInfo };

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;

export interface SpanSink {
  requestSpan(r: Rec, attempts?: readonly AttemptInfo[]): void;
  shutdown(): Promise<void>;
}

export const NOOP_SINK: SpanSink = { requestSpan: () => undefined, shutdown: () => Promise.resolve() };

type Attr = string | number | boolean;
type Attrs = Record<string, Attr>;

/** The GenAI operation of a surface: the three inference surfaces chat, count_tokens is its own operation. */
export function operationOf(surface: string): string {
  return surface === 'anthropic-count-tokens' ? 'count_tokens' : 'chat';
}

/** The well-known `gen_ai.provider.name` value of a surface; the policy's own provider name goes in `tokenyard.provider`. */
export function genAiProvider(surface: string): string {
  return surface === 'openai-responses' ? 'openai' : 'anthropic';
}

/** OTel's `input_tokens` is all input: input plus cache read plus cache write (Anthropic's own count excludes the cache). */
export function inputTokens(u: NonNullable<Rec['outcome']['usage']>): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

const label = (v: string): string => sanitizeHeaderValue(v).value;

function usageAttrs(r: Rec): Attrs {
  const u = r.outcome.usage;
  if (!u) return {};
  return {
    [GEN_AI.usageInputTokens]: inputTokens(u),
    [GEN_AI.usageOutputTokens]: u.output,
    [GEN_AI.usageCacheReadInputTokens]: u.cacheRead,
    [GEN_AI.usageCacheWriteInputTokens]: u.cacheWrite5m + u.cacheWrite1h,
  };
}

/** Attributes of the SERVER span (the inbound call). */
export function serverAttributes(r: Rec): Attrs {
  const a: Attrs = {
    [TOKENYARD.tenant]: label(r.tenant),
    [TOKENYARD.decision]: r.decision.action,
    [TOKENYARD.policyRevision]: label(r.policy.revision),
    [TOKENYARD.priceTable]: label(r.outcome.priceTable),
    [TOKENYARD.costBasis]: r.outcome.costBasis,
    'http.response.status_code': r.outcome.status,
  };
  if (r.team) a[TOKENYARD.team] = label(r.team);
  if (r.decision.route) a[TOKENYARD.route] = label(r.decision.route);
  if (r.decision.reason) a['tokenyard.decision.reason'] = label(r.decision.reason);
  if (r.attribution.requestClass) a[TOKENYARD.requestClass] = label(r.attribution.requestClass);
  if (r.attribution.agent) a[TOKENYARD.agentId] = r.attribution.agent;
  if (r.attribution.session) a[GEN_AI.conversationId] = r.attribution.session;
  if (r.outcome.costMicroUsd !== null) a[TOKENYARD.costUsd] = r.outcome.costMicroUsd / 1e6;
  if (r.outcome.addedTtfbMs !== null) a[TOKENYARD.addedTtfbMs] = r.outcome.addedTtfbMs;
  if (r.outcome.errorClass) a[GEN_AI.errorType] = label(r.outcome.errorClass);
  return a;
}

/** Attributes of one CLIENT span (an upstream attempt). Usage goes on the attempt that answered. */
export function clientAttributes(r: Rec, attempt: AttemptInfo | null, answered: boolean): Attrs {
  const model = r.features.model;
  const a: Attrs = {
    [GEN_AI.operationName]: operationOf(r.surface),
    [GEN_AI.providerName]: genAiProvider(r.surface),
    [GEN_AI.requestStream]: r.features.stream,
  };
  if (model) a[GEN_AI.requestModel] = label(model);
  const provider = attempt?.provider ?? r.outcome.provider;
  if (provider) a[TOKENYARD.provider] = label(provider);
  if (r.attribution.session) a[GEN_AI.conversationId] = r.attribution.session;
  if (attempt?.status != null) a['http.response.status_code'] = attempt.status;
  if (attempt?.errorType) a[GEN_AI.errorType] = label(attempt.errorType);
  else if (attempt?.status != null && attempt.status >= 400) a[GEN_AI.errorType] = String(attempt.status);
  if (answered) {
    if (r.outcome.upstreamModel) a[GEN_AI.responseModel] = label(r.outcome.upstreamModel);
    if (r.outcome.ttfbMs !== null) a[GEN_AI.responseTimeToFirstChunk] = r.outcome.ttfbMs / 1000;
    Object.assign(a, usageAttrs(r));
  }
  return a;
}

export interface TracerOptions {
  /** Replaces the OTLP exporter (tests pass an in-memory one). Still loads the SDK. */
  exporter?: unknown;
}

/**
 * A span sink for `endpoint` (an OTLP/HTTP base URL; `/v1/traces` is added), or a no-op sink when it is null. The
 * OpenTelemetry packages are loaded here, by dynamic import, and nowhere else.
 */
export async function createTracer(endpoint: string | null, opts: TracerOptions = {}): Promise<SpanSink> {
  if (endpoint === null && opts.exporter === undefined) return NOOP_SINK;
  const [api, base, resources] = await Promise.all([import('@opentelemetry/api'), import('@opentelemetry/sdk-trace-base'), import('@opentelemetry/resources')]);
  let exporter = opts.exporter as import('@opentelemetry/sdk-trace-base').SpanExporter | undefined;
  if (exporter === undefined) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const url = (endpoint as string).replace(/\/+$/, '');
    exporter = new OTLPTraceExporter({ url: url.endsWith('/v1/traces') ? url : `${url}/v1/traces` });
  }
  const processor = opts.exporter !== undefined ? new base.SimpleSpanProcessor(exporter) : new base.BatchSpanProcessor(exporter);
  const provider = new base.BasicTracerProvider({
    resource: resources.resourceFromAttributes({ 'service.name': 'tokenyard' }),
    spanProcessors: [processor],
  });
  const tracer = provider.getTracer('tokenyard');
  const { SpanKind, SpanStatusCode, trace, ROOT_CONTEXT } = api;
  return {
    requestSpan(r, attempts) {
      const start = Date.parse(r.ts);
      const end = start + r.outcome.totalMs;
      const server = tracer.startSpan(`tokenyard ${r.surface}`, { kind: SpanKind.SERVER, startTime: start, attributes: serverAttributes(r) }, ROOT_CONTEXT);
      if (r.outcome.status >= 500) server.setStatus({ code: SpanStatusCode.ERROR });
      const ctx = trace.setSpan(ROOT_CONTEXT, server);
      const list: Array<AttemptInfo | null> = attempts && attempts.length > 0 ? [...attempts] : r.outcome.provider !== null ? [null] : [];
      const op = operationOf(r.surface);
      const name = `${op} ${label(r.features.model)}`.trim();
      list.forEach((attempt, i) => {
        const answered = attempt === null ? true : i === list.length - 1 && r.outcome.provider === attempt.provider;
        const s = tracer.startSpan(
          name,
          { kind: SpanKind.CLIENT, startTime: attempt?.startMs ?? start, attributes: { ...clientAttributes(r, attempt, answered), [TOKENYARD.attempt]: i + 1 } },
          ctx,
        );
        const status = attempt === null ? r.outcome.status : attempt.status;
        if (status === null || status >= 400) s.setStatus({ code: SpanStatusCode.ERROR });
        s.end(attempt?.endMs ?? end);
      });
      server.end(end);
    },
    shutdown: () => provider.shutdown(),
  };
}
