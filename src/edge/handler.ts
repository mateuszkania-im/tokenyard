import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { TraceRecord } from '../ledger/record.js';
import type { CounterStore } from '../limits/store.js';
import { pseudonym } from '../guardrails/hmac.js';
import { buildFeatures, decide } from '../policy/decide.js';
import { modelsForKey } from '../policy/match.js';
import { resolve } from '../policy/resolve.js';
import type { CompiledPolicy, Decision, KeyRecord, ProviderSpec, Surface } from '../policy/types.js';
import { costMicroUsd } from '../pricing/cost.js';
import { AnthropicUsageAccumulator, parseAnthropicJsonUsage, type UsageResult } from '../stream/anthropic-usage.js';
import { SseParser } from '../stream/sse.js';
import { createTee } from '../stream/tee.js';
import { extractCountTokensFeatures } from '../surfaces/anthropic-count-tokens.js';
import { extractAnthropicFeatures } from '../surfaces/anthropic-messages.js';
import { modelsListBody } from '../surfaces/anthropic-models.js';
import type { ExtractedFeatures } from '../surfaces/types.js';
import { forward, type UpstreamResponse } from '../upstream/forward.js';
import { readAttribution, type RawAttribution } from './attribution.js';
import { extractCredentials, hashKey } from './auth.js';
import { BodyTooLargeError, readBody } from './body.js';
import { anthropicError } from './errors.js';
import { clientHeaders, upstreamHeaders } from './headers.js';
import { matchRoute } from './paths.js';
import { buildTraceRecord, parseClient } from './trace-record.js';

/** Where finished request records go. Implemented by `TraceWriter`; `null` when `--trace-dir` is not set. */
export interface TraceSink {
  write(r: Omit<TraceRecord, 'instance' | 'seq'>): boolean;
}

export interface GatewayDeps {
  policy(): CompiledPolicy;
  store: CounterStore | null;
  traces: TraceSink | null;
  clock(): number;
  newId(): string;
  basePath: string | null;
  bodyCapBytes: number;
  /** `serve --experimental-subscription` (spec 6.8): without it keys with `billing: subscription` get 401. */
  experimentalSubscription?: boolean;
  /** HMAC salt for session, agent, parent agent and prompt id in traces (spec 9.1); required when `traces` is set. */
  traceSalt?: string;
  /** Called after the response has ended with what the request knew (tests; settlement, Task 14, replaces it). The trace record is queued separately. */
  onSettled?: (outcome: RequestOutcome) => void;
}

/** What the end of a request knows; settlement (Task 14) and the trace (Task 7) are built from it. */
export interface RequestOutcome {
  id: string;
  key: KeyRecord;
  attribution: RawAttribution;
  surface: Surface;
  features: ExtractedFeatures;
  /** Null when the request never reached a provider. */
  provider: string | null;
  status: number;
  usage: UsageResult | null;
  aborted: boolean;
  startedAt: number;
  ttfbMs: number | null;
  totalMs: number;
  /** Actual cost from the final or partial usage; null when there is no usage or the model is unpriced. */
  costMicroUsd: number | null;
  /** `api-equivalent` for subscription keys (spec 7.6), else `billed`. */
  costBasis: 'billed' | 'api-equivalent';
  /** Time from request received to first byte written, minus the upstream's own time to first byte (spec 9.1). */
  addedTtfbMs: number | null;
  /** From the User-Agent header. */
  client: { agent: 'claude-code' | 'codex' | 'other'; version: string | null };
  policyRevision: string;
  /** Route the request was sent through; null for a request no route served. */
  route: { name: string; chain: readonly string[] } | null;
  priceTable: string;
  /** Block or forward, with the reason for a block; absent means forward. */
  decision?: { action: 'forward' | 'block'; reason: string | null };
  /** Input token bound the decision used (spec 7.3); absent for exits before features were extracted. */
  inputBound?: { tokens: number; kind: 'bytes' | 'context-window' };
  /** The reservation is not a bound for this request (spec 7.4). */
  boundAssumed?: boolean;
  /** Audit mode (spec 6.5): what the candidate policy decided for the same request. */
  candidate?: { revision: string; route: string | null; action: 'forward' | 'block'; reason: string | null; chain: string[] };
  /** Set for requests that failed or were refused before a response came from upstream. */
  errorClass?: string;
  /** Upstream `anthropic-ratelimit-unified-*` response headers. */
  rateLimitHeaders?: Record<string, string>;
}

type ErrorReply = ReturnType<typeof anthropicError>;

function sendError(req: IncomingMessage, res: ServerResponse, e: ErrorReply, closeConnection = false): void {
  // An early answer leaves an unread upload behind; drain it (or close the connection) so the socket is not stuck.
  req.resume();
  res.writeHead(e.status, closeConnection ? { ...e.headers, connection: 'close' } : e.headers).end(e.body);
}

/** Session, agent, parent agent and prompt id as the trace stores them, so replay decides on the same values (spec 9.1). */
function pseudonymised(a: RawAttribution, salt: string | undefined): RawAttribution {
  if (!salt) return a;
  const h = (v: string | null): string | null => (v === null ? null : pseudonym(salt, v));
  return { ...a, session: h(a.session), agent: h(a.agent), parentAgent: h(a.parentAgent), promptId: h(a.promptId) };
}

const summary = (d: Decision): { route: string | null; action: 'forward' | 'block'; reason: string | null; chain: string[] } => ({
  route: d.plan.route,
  action: d.action,
  reason: d.block?.reason ?? null,
  chain: d.plan.chain.map((c) => c.provider),
});

function rateLimitHeaders(h: UpstreamResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith('anthropic-ratelimit-unified-')) out[k] = String(Array.isArray(v) ? v[0] : v);
  }
  return out;
}

function providerCredential(p: ProviderSpec): { header: 'x-api-key' | 'authorization'; value: string } | null {
  if (p.credential === 'passthrough') return null;
  const value = process.env[p.credential.env];
  if (!value) return null; // upstream answers 401, which reaches the client unchanged
  return p.format === 'anthropic' ? { header: 'x-api-key', value } : { header: 'authorization', value: `Bearer ${value}` };
}

function extractFeatures(surface: Surface, body: Buffer): ExtractedFeatures {
  return surface === 'anthropic-count-tokens' ? extractCountTokensFeatures(body) : extractAnthropicFeatures(body);
}

/** Watches the response bytes for usage without delaying or changing them (spec 5.3 step 11). */
function usageTap(surface: Surface, up: UpstreamResponse, capBytes: number): { onChunk(c: Buffer): void; result(): UsageResult | null } {
  if (surface !== 'anthropic-messages') return { onChunk: () => undefined, result: () => null };
  const ct = String(up.headers['content-type'] ?? '');
  if (ct.startsWith('text/event-stream')) {
    const parser = new SseParser();
    const acc = new AnthropicUsageAccumulator();
    return {
      onChunk: (c) => {
        for (const e of parser.push(c)) acc.onEvent(e);
      },
      result: () => acc.result(),
    };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    onChunk: (c) => {
      size += c.length;
      if (size <= capBytes) chunks.push(c);
    },
    result: () => (size <= capBytes ? parseAnthropicJsonUsage(Buffer.concat(chunks)) : null),
  };
}

function priceOutcome(policy: CompiledPolicy, features: ExtractedFeatures, usage: UsageResult | null): number | null {
  const model = usage?.responseModel ?? features.model;
  if (!usage?.usage || !model) return null;
  try {
    return costMicroUsd(policy.prices, model, usage.usage);
  } catch {
    return null; // unpriced model: Task 10's `unpricedModel` policy decides what that means
  }
}

/** After `res.end()`: the trace record is queued (never waits on disk); settlement (Task 14) hooks in here too. */
function afterResponse(deps: GatewayDeps, outcome: RequestOutcome): void {
  deps.onSettled?.(outcome);
  if (deps.traces) deps.traces.write(buildTraceRecord(outcome, deps.traceSalt ?? ''));
}

const NO_FEATURES: ExtractedFeatures = {
  model: null, stream: false, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], bodyBytes: 0,
  prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: false, lastTurn: null,
};

async function handle(deps: GatewayDeps, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = deps.clock();
  const policy = deps.policy();
  // A cancelled client turn must stop upstream generation: abort as soon as the client goes away.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });

  // 1. Accept.
  const method = req.method ?? 'GET';
  const match = matchRoute(method, req.url ?? '/', deps.basePath);
  if (!match) {
    const path = (req.url ?? '/').split('?')[0];
    return sendError(req, res, anthropicError(404, 'not_found_error', `no route for ${method} ${path}`, null, id));
  }
  if (match.surface === 'hello') {
    req.resume();
    res.writeHead(200, { 'content-length': '0' }).end();
    return;
  }

  // 2. Authenticate.
  // In subscription mode `Authorization` carries the user's OAuth token, so every credential is tried, not only the first.
  const creds = extractCredentials(req.headers);
  let key: KeyRecord | undefined;
  const keyHeaders = new Set<'authorization' | 'x-api-key'>();
  for (const c of creds) {
    const k = policy.keysByHash.get(hashKey(c.value));
    if (!k) continue;
    key ??= k;
    if (c.source === 'bearer') keyHeaders.add('authorization');
    else if (c.source === 'x-api-key') keyHeaders.add('x-api-key');
  }
  if (!key) {
    return sendError(req, res, anthropicError(401, 'authentication_error', 'missing or unknown tokenyard key', null, id));
  }
  if (key.billing === 'subscription' && !deps.experimentalSubscription) {
    return sendError(req, res, anthropicError(401, 'authentication_error', 'subscription keys are not enabled on this gateway', null, id));
  }

  if (match.surface === 'models') {
    req.resume();
    const body = modelsListBody(modelsForKey(policy, key));
    res
      .writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length), 'x-tokenyard-request-id': id })
      .end(body);
    return;
  }
  const surface = match.surface;

  // An authenticated request that ends before a response came from upstream still gets its trace line (spec 9.1).
  const early = (over: Partial<RequestOutcome> & Pick<RequestOutcome, 'status'>): void =>
    afterResponse(deps, {
      id,
      key,
      attribution: readAttribution(req.headers, surface),
      surface,
      features: NO_FEATURES,
      provider: null,
      usage: null,
      aborted: false,
      startedAt,
      ttfbMs: null,
      totalMs: deps.clock() - startedAt,
      costMicroUsd: null,
      costBasis: key.billing === 'subscription' ? 'api-equivalent' : 'billed',
      addedTtfbMs: null,
      client: parseClient(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined),
      policyRevision: policy.revision,
      route: null,
      priceTable: policy.priceTableVersion,
      ...over,
    });

  // 3. Read the body.
  let body: Buffer;
  try {
    body = await readBody(req, deps.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      const msg = `request body is larger than the ${err.capBytes} byte limit`;
      sendError(req, res, anthropicError(413, 'request_too_large', msg, null, id), true);
      early({ status: 413, decision: { action: 'block', reason: 'body-too-large' }, errorClass: 'request_too_large' });
    } else {
      early({ status: 499, aborted: true, errorClass: 'client_abort' }); // the client went away mid-upload
    }
    return;
  }

  // 4. Extract features (read-only; the body Buffer is forwarded as received).
  const features = extractFeatures(surface, body);

  // 5 to 8. Guardrails (Task 16), decide, admit (Task 14: until then no admission), resolve.
  const f = buildFeatures(features, key, pseudonymised(readAttribution(req.headers, surface), deps.traceSalt), [], policy.prices, id, startedAt, surface);
  const decision = resolve(policy, decide(policy, f), null);
  const cp = policy.candidate;
  const candidate = cp ? { revision: cp.revision, ...summary(resolve(cp, decide(cp, f), null)) } : undefined;
  const planned = summary(decision);
  const routeInfo = planned.route === null ? null : { name: planned.route, chain: planned.chain };
  const decided = {
    features,
    inputBound: { tokens: f.inputTokensBound, kind: f.boundKind },
    boundAssumed: decision.plan.warnings.some((w) => w.kind === 'bound-assumed'),
    route: routeInfo,
    ...(candidate ? { candidate } : {}),
  };
  const first = decision.plan.chain[0];
  const provider = first === undefined ? undefined : policy.providers.get(first.provider);
  if (decision.block || !provider) {
    const b = decision.block ?? { status: 403 as const, type: 'permission_error', reason: 'no-route' as const, message: 'no provider serves this route', retryAfterS: null };
    sendError(req, res, anthropicError(b.status, b.type, b.message, b.retryAfterS, id));
    return early({ ...decided, status: b.status, decision: { action: 'block', reason: b.reason }, errorClass: b.type });
  }

  // 9. Forward.
  const mode = provider.credential === 'passthrough' ? 'passthrough' : 'api';
  // A tokenyard key is never forwarded, in whichever header it came; any other Authorization (the OAuth token) is.
  const headers = upstreamHeaders(req.headers, {
    mode,
    credential: providerCredential(provider),
    host: new URL(provider.baseUrl).host,
    clientKeyHeaders: [...keyHeaders],
  });
  let up: UpstreamResponse;
  const forwardedAt = deps.clock();
  try {
    up = await forward(provider, { method, pathAndQuery: match.pathAndQuery, headers, body }, ac.signal);
  } catch {
    const common = { ...decided, provider: provider.name };
    if (ac.signal.aborted) return early({ ...common, status: 499, aborted: true, errorClass: 'client_abort' });
    sendError(req, res, anthropicError(502, 'api_error', `upstream ${provider.name} is unreachable`, null, id));
    return early({ ...common, status: 502, errorClass: 'upstream_unreachable' });
  }
  if (ac.signal.aborted) {
    up.body.on('error', () => undefined);
    up.body.destroy();
    return early({ ...decided, provider: provider.name, status: 499, aborted: true, errorClass: 'client_abort' });
  }

  // 10. First response headers: written and flushed at once, never compressed.
  const upstreamHeadersAt = deps.clock();
  const ttfbMs = upstreamHeadersAt - startedAt;
  res.writeHead(
    up.status,
    clientHeaders(up.headers, {
      'x-tokenyard-request-id': id,
      'x-tokenyard-policy-revision': policy.revision,
      'X-Accel-Buffering': 'no',
    }),
  );
  res.flushHeaders();

  // 11. Body: every chunk goes on unchanged before it is parsed; backpressure through pipeline.
  const tap = usageTap(surface, up, deps.bodyCapBytes);
  try {
    await pipeline(up.body, createTee(tap.onChunk), res);
  } catch {
    // Client abort or upstream drop: the client sees exactly what upstream sent, truncated; nothing is synthesised.
  }

  // 12. End.
  const usage = tap.result();
  afterResponse(deps, {
    id,
    key,
    attribution: readAttribution(req.headers, surface),
    surface,
    ...decided,
    provider: provider.name,
    status: up.status,
    usage,
    aborted: ac.signal.aborted,
    startedAt,
    ttfbMs,
    totalMs: deps.clock() - startedAt,
    costMicroUsd: priceOutcome(policy, features, usage),
    costBasis: key.billing === 'subscription' ? 'api-equivalent' : 'billed',
    addedTtfbMs: Math.max(0, ttfbMs - (upstreamHeadersAt - forwardedAt)),
    client: parseClient(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined),
    policyRevision: policy.revision,
    priceTable: policy.priceTableVersion,
    rateLimitHeaders: rateLimitHeaders(up.headers),
  });
}

export function createHandler(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  if (deps.traces && !deps.traceSalt) throw new Error('traces need a traceSalt: session and agent ids are HMAC pseudonyms (spec 9.1)');
  return (req, res) => {
    const id = deps.newId();
    handle(deps, id, req, res).catch(() => {
      if (!res.headersSent) sendError(req, res, anthropicError(500, 'api_error', 'internal error', null, id));
      else res.destroy();
    });
  };
}
