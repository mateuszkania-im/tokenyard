import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { TraceRecord } from '../ledger/record.js';
import type { CounterStore } from '../limits/store.js';
import { pseudonym } from '../guardrails/hmac.js';
import { buildFeatures, decide } from '../policy/decide.js';
import { modelsForKey } from '../policy/match.js';
import { resolve } from '../policy/resolve.js';
import type { Admission, CompiledPolicy, Decision, KeyRecord, Plan, ProviderSpec, RequestFeatures, Surface } from '../policy/types.js';
import { costMicroUsd } from '../pricing/cost.js';
import { AnthropicUsageAccumulator, parseAnthropicJsonUsage, type UsageResult } from '../stream/anthropic-usage.js';
import { SseParser } from '../stream/sse.js';
import { createTee } from '../stream/tee.js';
import { extractCountTokensFeatures } from '../surfaces/anthropic-count-tokens.js';
import { extractAnthropicFeatures, rewriteTopLevelModel } from '../surfaces/anthropic-messages.js';
import { modelsListBody } from '../surfaces/anthropic-models.js';
import type { ExtractedFeatures } from '../surfaces/types.js';
import { Breaker } from '../upstream/breaker.js';
import { ChainError, runChain, workspaceOf } from '../upstream/chain.js';
import type { UpstreamResponse } from '../upstream/forward.js';
import { RetryBudget } from '../upstream/retry-budget.js';
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

/** Process-local failure state (spec 8): never in `policy/`, which is pure. */
export interface FailureState {
  breaker: Breaker;
  retry: RetryBudget;
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
  /** Called after settlement with what the request knew (tests). The trace record is queued separately. */
  onSettled?: (outcome: RequestOutcome) => void;
  /** Process state that outlives requests (R11 latch, sweeper notices); one is created when absent. */
  runtime?: GatewayRuntime;
}

/** Per-process runtime state: never in `policy/`, which is pure, and gone on restart by design. */
export interface GatewayRuntime {
  /** R11: set when a settled request billed more input than its bytes bound; every later request uses the context-window bound until restart. */
  bytesBoundOff: boolean;
  /** Requests whose billed input exceeded their bytes bound (a counter for /metrics). */
  boundViolations: number;
  /** Ids the sweeper settled at their estimate (pass as the store's `onSwept`); never throws. */
  onSwept(ids: string[]): void;
  /** Whether the sweeper settled this request; forgets the id. */
  takeSwept(id: string): boolean;
}

/** Ids remembered for requests the sweeper settled; a request that never comes back must not grow it without end. */
const SWEPT_MAX = 100_000;

export function createGatewayRuntime(): GatewayRuntime {
  const swept = new Set<string>();
  return {
    bytesBoundOff: false,
    boundViolations: 0,
    onSwept(ids) {
      try {
        for (const id of ids) swept.add(id);
        for (const id of swept) {
          if (swept.size <= SWEPT_MAX) break;
          swept.delete(id);
        }
      } catch {
        // a sweep notice must never fail the sweep
      }
    },
    takeSwept(id) {
      return swept.delete(id);
    },
  };
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
  /** Upstream attempts made (1 without fallback); absent before any attempt. */
  attempts?: number;
  /** The answering provider is in another workspace than the first in the chain, so its prompt cache starts cold (spec 8). */
  cacheColdRisk?: boolean;
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
  candidate?: { revision: string; route: string | null; action: 'forward' | 'block'; reason: string | null; chain: string[] } | { revision: string; error: string };
  /** Set for requests that failed or were refused before a response came from upstream. */
  errorClass?: string;
  /** Upstream `anthropic-ratelimit-unified-*` response headers. */
  rateLimitHeaders?: Record<string, string>;
  /** Estimate reserved on each budget level by an admitted request; 0 or absent when nothing was reserved. */
  reservedMicroUsd?: number;
  /** Audit-mode budget levels as admit saw them. */
  audit?: Admission['audit'];
  /** Admit could not reach the counter store; failure.counterStoreDown applied. */
  storeDown?: boolean;
  /** The store was down, so the session taint was not checked (spec 6.6). */
  taintUnchecked?: boolean;
  /** `sweeper` when the reservation was settled by the sweeper at its estimate, not by this request. */
  settledBy?: 'request' | 'sweeper';
  /** Actual cost above the reservation (spec 7.4: cannot happen under its premises). */
  overrun?: boolean;
  /** The actual cost could not be computed; the reservation estimate was settled and is `costMicroUsd`. */
  settledAtEstimate?: boolean;
  /** R11: the billed input exceeded the bytes bound. */
  boundExceeded?: boolean;
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

/** Audit mode must never touch the live request: whatever the candidate does, including throwing, ends up on the trace only. */
function auditCandidate(cp: CompiledPolicy, f: Parameters<typeof decide>[1]): NonNullable<RequestOutcome['candidate']> {
  try {
    return { revision: cp.revision, ...summary(resolve(cp, decide(cp, structuredClone(f)), null)) };
  } catch (e) {
    return { revision: cp.revision, error: e instanceof Error ? e.name : 'Error' };
  }
}

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

/** What the request holds in the counter store, so every exit after admit settles it (spec 5.3 step 12). */
interface Held {
  plan: Plan | null;
  features: RequestFeatures | null;
  /** Admit took a reservation (and slots) that settle must release. */
  admitted: boolean;
  /** The estimate reserved on each budget level (0 without budget levels). */
  est: number;
  /** The response was an SSE stream: no `message_start` means nothing was billed. */
  streamed: boolean;
}

const totalInput = (u: NonNullable<UsageResult['usage']>): number => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

/** Actual cost from the usage (spec 7.6), fast mode from the response or the request; throws when it cannot be priced. */
function actualCost(policy: CompiledPolicy, model: string, usage: NonNullable<UsageResult['usage']>, r: UsageResult, fastRequested: boolean): number {
  return costMicroUsd(policy.prices, model, usage, { fast: r.fast === true || fastRequested, ...(r.serverToolUses ? { serverToolUses: r.serverToolUses } : {}) });
}

/**
 * After `res.end()`: price the usage, settle the reservation (which also frees the stream slots), then queue the trace
 * (never waits on disk). Never throws: a store that fails here leaves the reservation to the sweeper.
 */
async function settleAndTrace(deps: GatewayDeps, runtime: GatewayRuntime, policy: CompiledPolicy, held: Held, outcome: RequestOutcome): Promise<void> {
  const o: RequestOutcome = { ...outcome };
  const r = o.usage;
  const model = r?.responseModel ?? held.plan?.chain[0]?.upstreamModel ?? o.features.model;
  let cost: number | null = null;
  let costFailed = false;
  if (r?.usage && model) {
    try {
      cost = actualCost(policy, model, r.usage, r, o.features.fastMode);
    } catch {
      costFailed = true; // unpriced model or fast mode, an invalid cost: fail closed below
    }
  } else if (r === null && o.provider !== null && o.status >= 200 && o.status < 300 && !held.streamed && !o.aborted) {
    costFailed = true; // a successful JSON answer whose usage could not be read (larger than the cap)
  }
  if (held.admitted) {
    let actual = cost ?? 0;
    if (costFailed) {
      actual = held.est;
      o.settledAtEstimate = true;
    }
    o.costMicroUsd = actual;
    o.overrun = (held.plan?.reservations.length ?? 0) > 0 && actual > held.est;
    let result: 'settled' | 'unknown' | 'failed';
    try {
      result = await (deps.store as CounterStore).settle(o.id, actual);
    } catch {
      result = 'failed'; // the record stays; the sweeper settles it at the estimate
    }
    // Swept here (onSwept), or the record was already gone ('unknown': swept by another instance), or it is left for
    // the sweeper ('failed'): in each case the sweeper settles it at its estimate.
    const swept = runtime.takeSwept(o.id);
    o.settledBy = swept || result !== 'settled' ? 'sweeper' : 'request';
  } else {
    o.costMicroUsd = cost;
  }

  // R11: the bytes bound rests on at most one token per byte; one violation turns it off for this process.
  const f = held.features;
  if (r?.usage && f?.boundKind === 'bytes' && totalInput(r.usage) > f.inputTokensBound) {
    o.boundExceeded = true;
    runtime.boundViolations++;
    if (!runtime.bytesBoundOff) {
      runtime.bytesBoundOff = true;
      console.error(`tokenyard: request ${o.id} billed ${totalInput(r.usage)} input tokens, above its bytes bound of ${f.inputTokensBound}; the bytes bound is off (context-window bound for every request) until restart`);
    }
  }
  try {
    deps.onSettled?.(o);
    if (deps.traces) deps.traces.write(buildTraceRecord(o, deps.traceSalt ?? ''));
  } catch {
    // a failing trace sink must not turn a served request into an error
  }
}

const NO_FEATURES: ExtractedFeatures = {
  model: null, stream: false, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], bodyBytes: 0,
  prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: false, lastTurn: null,
};

async function handle(deps: GatewayDeps, failure: FailureState, runtime: GatewayRuntime, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  // What this request holds in the counter store; every exit below settles it before the trace is queued.
  const held: Held = { plan: null, features: null, admitted: false, est: 0, streamed: false };

  // An authenticated request that ends before a response came from upstream still gets its trace line (spec 9.1).
  const early = (over: Partial<RequestOutcome> & Pick<RequestOutcome, 'status'>): Promise<void> =>
    settleAndTrace(deps, runtime, policy, held, {
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
      return early({ status: 413, decision: { action: 'block', reason: 'body-too-large' }, errorClass: 'request_too_large' });
    }
    return early({ status: 499, aborted: true, errorClass: 'client_abort' }); // the client went away mid-upload
  }

  // 4. Extract features (read-only; the body Buffer is forwarded as received).
  const features = extractFeatures(surface, body);

  // 5 and 6. Guardrails (Task 16), decide. A reservation that cannot be priced (the estimator throws) fails closed:
  // refused before admit, so nothing is reserved.
  let f: RequestFeatures;
  let plan: Plan;
  try {
    f = buildFeatures(features, key, pseudonymised(readAttribution(req.headers, surface), deps.traceSalt), [], policy.prices, id, startedAt, surface, { bytesBoundOff: runtime.bytesBoundOff });
    plan = decide(policy, f);
  } catch {
    sendError(req, res, anthropicError(500, 'api_error', 'the reservation for this request could not be computed; it was not sent', null, id));
    return early({ features, status: 500, decision: { action: 'block', reason: 'reservation-error' }, errorClass: 'reservation_error' });
  }
  held.plan = plan;
  held.features = f;
  const cp = policy.candidate;
  const candidate = cp ? auditCandidate(cp, f) : undefined;
  const chainNames = plan.chain.map((c) => c.provider);
  const decided = {
    features,
    inputBound: { tokens: f.inputTokensBound, kind: f.boundKind },
    boundAssumed: plan.warnings.some((w) => w.kind === 'bound-assumed'),
    route: plan.route === null ? null : { name: plan.route, chain: chainNames },
    ...(candidate ? { candidate } : {}),
  };
  const first = plan.chain[0];

  // rewriteModel (product routes, or coding-agent routes behind allowBodyRewrite): only the bytes of the top-level
  // model value change; the reservation is priced at this served model. Not locatable exactly: refuse, never guess.
  // Decided before admission, so a request that cannot be sent never reserves anything.
  let upstreamBody = body;
  if (plan.preBlock === null && first?.rewritesModel) {
    const rewritten = rewriteTopLevelModel(body, first.upstreamModel);
    if (!rewritten) {
      const msg = `route "${plan.route ?? ''}" rewrites the model, but the request's top-level model field could not be located exactly (send one JSON object with a single string "model")`;
      sendError(req, res, anthropicError(400, 'invalid_request_error', msg, null, id));
      return early({ ...decided, status: 400, decision: { action: 'block', reason: 'model-rewrite-failed' }, errorClass: 'invalid_request_error' });
    }
    upstreamBody = rewritten;
  }

  // 7. Admit: one store call for rate checks, stream slots, taint and every reservation (spec 7). Blocks that need no
  // counters (preBlocks, a reservation larger than its limit on its own) are answered without one; a last-turn secret
  // still calls it to write the session taint. count_tokens plans hold nothing, so they never reach the store.
  const pre = resolve(policy, plan, null);
  const taintWrite = plan.preBlock === 'secret' && (plan.taint?.add.length ?? 0) > 0;
  let admission: Admission | null = null;
  if (deps.store !== null && (taintWrite || (pre.block === null && holdsCounters(plan)))) {
    try {
      admission = await deps.store.admit(plan);
    } catch {
      admission = { admitted: false, failed: null, audit: [], totals: [], storeDown: true };
    }
  }
  held.admitted = admission?.admitted === true && admission.storeDown !== true && plan.preBlock === null;
  held.est = held.admitted ? (plan.reservations[0]?.estMicroUsd ?? 0) : 0;
  const admitted = {
    reservedMicroUsd: held.est,
    ...(admission ? { audit: admission.audit } : {}),
    ...(admission?.storeDown ? { storeDown: true, taintUnchecked: plan.taint !== null } : {}),
  };

  // 8. Resolve.
  const decision = admission === null ? pre : resolve(policy, plan, admission);
  const provider = first === undefined ? undefined : policy.providers.get(first.provider);
  if (decision.block || !provider) {
    const b = decision.block ?? { status: 403 as const, type: 'permission_error', reason: 'no-route' as const, message: 'no provider serves this route', retryAfterS: null };
    sendError(req, res, anthropicError(b.status, b.type, b.message, b.retryAfterS, id));
    return early({ ...decided, ...admitted, status: b.status, decision: { action: 'block', reason: b.reason }, errorClass: b.type });
  }

  // 9. Forward: the chain tries providers until one answers usably, and only before any byte reaches the client (spec 8).
  // A tokenyard key is never forwarded, in whichever header it came; any other Authorization (the OAuth token) is.
  const headersFor = (p: ProviderSpec): Record<string, string | string[]> =>
    upstreamHeaders(req.headers, {
      mode: p.credential === 'passthrough' ? 'passthrough' : 'api',
      credential: providerCredential(p),
      host: new URL(p.baseUrl).host,
      clientKeyHeaders: [...keyHeaders],
    });
  let up: UpstreamResponse;
  let answered: ProviderSpec = provider;
  let attempts: number;
  const forwardedAt = deps.clock();
  try {
    const r = await runChain(plan, policy, { method, pathAndQuery: match.pathAndQuery, headers: headersFor(provider), body: upstreamBody }, ac.signal, {
      ...failure,
      tenant: key.tenant,
      clock: deps.clock,
      headersFor,
    });
    up = r.response;
    attempts = r.attempt;
    answered = policy.providers.get(r.provider) ?? provider;
  } catch (err) {
    // Nothing came back, so nothing was billed: the reservation settles at 0 and the slot is freed.
    const n = err instanceof ChainError ? err.attempts : 1;
    const common = { ...decided, ...admitted, provider: err instanceof ChainError && err.provider ? err.provider : provider.name, attempts: n };
    if (ac.signal.aborted) return early({ ...common, status: 499, aborted: true, errorClass: 'client_abort' });
    sendError(req, res, anthropicError(502, 'api_error', `upstream ${common.provider} is unreachable`, null, id));
    return early({ ...common, status: 502, errorClass: 'upstream_unreachable' });
  }
  const answer = { provider: answered.name, attempts, cacheColdRisk: workspaceOf(answered) !== workspaceOf(provider) };
  if (ac.signal.aborted) {
    up.body.on('error', () => undefined);
    up.body.destroy();
    return early({ ...decided, ...admitted, ...answer, status: 499, aborted: true, errorClass: 'client_abort' });
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
  held.streamed = String(up.headers['content-type'] ?? '').startsWith('text/event-stream');
  try {
    await pipeline(up.body, createTee(tap.onChunk), res);
  } catch {
    // Client abort or upstream drop: the client sees exactly what upstream sent, truncated; nothing is synthesised.
  }

  // 12. End: settle with the computed cost, then queue the trace (both after res.end()).
  await settleAndTrace(deps, runtime, policy, held, {
    id,
    key,
    attribution: readAttribution(req.headers, surface),
    surface,
    ...decided,
    ...admitted,
    ...answer,
    status: up.status,
    usage: tap.result(),
    aborted: ac.signal.aborted,
    startedAt,
    ttfbMs,
    totalMs: deps.clock() - startedAt,
    costMicroUsd: null,
    costBasis: key.billing === 'subscription' ? 'api-equivalent' : 'billed',
    addedTtfbMs: Math.max(0, ttfbMs - (upstreamHeadersAt - forwardedAt)),
    client: parseClient(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined),
    policyRevision: policy.revision,
    priceTable: policy.priceTableVersion,
    rateLimitHeaders: rateLimitHeaders(up.headers),
  });
}

/** Whether admit has anything to check or write for this plan. */
function holdsCounters(plan: Plan): boolean {
  const t = plan.taint;
  return plan.reservations.length + plan.rateChecks.length + plan.streamSlots.length > 0 || (t !== null && t.check.length + t.add.length > 0);
}

export function createHandler(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  if (deps.traces && !deps.traceSalt) throw new Error('traces need a traceSalt: session and agent ids are HMAC pseudonyms (spec 9.1)');
  const runtime = deps.runtime ?? createGatewayRuntime();
  // Breaker and retry budget outlive requests; they are rebuilt only when a reload changes the `failure` settings.
  let state: { settings: string; failure: FailureState } | null = null;
  const failureState = (policy: CompiledPolicy): FailureState => {
    const settings = JSON.stringify([policy.failure.breaker, policy.failure.retryBudgetRatio]);
    if (state?.settings !== settings) {
      state = { settings, failure: { breaker: new Breaker(policy.failure.breaker, deps.clock), retry: new RetryBudget(policy.failure.retryBudgetRatio, deps.clock) } };
    }
    return state.failure;
  };
  return (req, res) => {
    const id = deps.newId();
    handle(deps, failureState(deps.policy()), runtime, id, req, res).catch(() => {
      if (!res.headersSent) sendError(req, res, anthropicError(500, 'api_error', 'internal error', null, id));
      else res.destroy();
    });
  };
}
