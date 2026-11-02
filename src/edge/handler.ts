import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { TraceRecord } from '../ledger/record.js';
import type { CounterStore } from '../limits/store.js';
import { pseudonym } from '../guardrails/hmac.js';
import { PII_RULES } from '../guardrails/pii.js';
import { type RedactionHit, redactionHits, redactProductBody } from '../guardrails/redact.js';
import { DEFAULT_RULES } from '../guardrails/rules.js';
import { findSpans, scanBody } from '../guardrails/scan.js';
import { buildFeatures, decide } from '../policy/decide.js';
import { modelsForKey } from '../policy/match.js';
import { isAdmitted, planAdmission } from '../policy/admission.js';
import { resolve } from '../policy/resolve.js';
import type { Admission, CompiledPolicy, Decision, GuardrailHit, KeyRecord, Plan, ProviderSpec, RequestFeatures, Surface } from '../policy/types.js';
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
import { anthropicError, retryable } from './errors.js';
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
  /**
   * HMAC salt for secret values (session taint, trace hits). Defaults to `traceSalt`, else a random salt per process:
   * then taint written by one instance is not recognised by another sharing the same Redis.
   */
  guardrailSalt?: string;
  /** Called after settlement with what the request knew (tests). The trace record is queued separately. */
  onSettled?: (outcome: RequestOutcome) => void;
  /** Process state that outlives requests (R11 latch, sweeper notices); one is created when absent. */
  runtime?: GatewayRuntime;
  /** How long admit and settle may take before the store counts as down (default 1 s): a slow store must not hang requests. */
  admitTimeoutMs?: number;
  /** Where provider credentials (`credential: { env }`) are read inside this process (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_ADMIT_TIMEOUT_MS = 1_000;

class StoreTimeoutError extends Error {}

/** Rejects with StoreTimeoutError when `p` takes longer than `ms`; `p` keeps running. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreTimeoutError(`counter store did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Per-process runtime state: never in `policy/`, which is pure, and gone on restart by design. */
export interface GatewayRuntime {
  /** R11: set when a settled request billed more input than its bytes bound; every later request uses the context-window bound until restart. */
  bytesBoundOff: boolean;
  /** Requests whose billed input exceeded their bytes bound (a counter for /metrics). */
  boundViolations: number;
  /** Admit calls made by this process, in call order; each request's number is traced so replay can order admits that share a millisecond. */
  admits: number;
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
    admits: 0,
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
  /** Guardrail hits (spec 6.6): rule, action, value HMAC and where; never the value. */
  guardrailHits?: GuardrailHit[];
  /** `sweeper` when the reservation was settled by the sweeper at its estimate, not by this request. */
  settledBy?: 'request' | 'sweeper';
  /** Actual cost above the reservation (spec 7.4: cannot happen under its premises). */
  overrun?: boolean;
  /** The actual cost could not be computed; the reservation estimate was settled and is `costMicroUsd`. */
  settledAtEstimate?: boolean;
  /** R11: the billed input exceeded the bytes bound. */
  boundExceeded?: boolean;
  /** What the store charged the budget levels at settlement (the estimate when the sweeper settled); absent without a reservation. */
  chargedMicroUsd?: number;
  /** Price table modifiers the request selected, as the cost was priced (replay reprices with them). */
  costModifiers?: string[];
  /** When admit was called, in ms after the request started, and the process's admit call number: replay admits in this order. */
  admitAt?: { offsetMs: number; seq: number };
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

function providerCredential(p: ProviderSpec, env: NodeJS.ProcessEnv): { header: 'x-api-key' | 'authorization'; value: string } | null {
  if (p.credential === 'passthrough') return null;
  const value = env[p.credential.env];
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
  /** Settlement has started; the fault path in `createHandler` settles an admitted request that never got here. */
  settled: boolean;
  /** What the request knew once admitted, so the fault path can still queue its trace line (warm-up reads the charge). */
  known: Omit<RequestOutcome, 'status' | 'usage' | 'aborted' | 'ttfbMs' | 'totalMs' | 'costMicroUsd' | 'addedTtfbMs'> | null;
}

const totalInput = (u: NonNullable<UsageResult['usage']>): number => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

/** Price table modifiers the request selects: `inference_geo: "us"` is `inferenceGeoUs`; a geo without an entry has none. */
function requestModifiers(policy: CompiledPolicy, x: ExtractedFeatures): string[] {
  if (x.inferenceGeo === undefined || x.inferenceGeo === '') return [];
  const geo = x.inferenceGeo.toLowerCase();
  const name = `inferenceGeo${geo.charAt(0).toUpperCase()}${geo.slice(1)}`;
  return Object.hasOwn(policy.prices.modifiers, name) ? [name] : [];
}

/**
 * Actual cost from the usage (spec 7.6): fast mode from the response or the request, the request's modifiers, server
 * tool uses. Throws when it cannot be priced.
 */
function actualCost(policy: CompiledPolicy, model: string, r: UsageResult & { usage: NonNullable<UsageResult['usage']> }, x: ExtractedFeatures): number {
  return costMicroUsd(policy.prices, model, r.usage, {
    fast: r.fast === true || x.fastMode,
    modifiers: requestModifiers(policy, x),
    ...(r.serverToolUses ? { serverToolUses: r.serverToolUses } : {}),
  });
}

/**
 * After `res.end()`: price the usage, settle the reservation (which also frees the stream slots), then queue the trace
 * (never waits on disk). Never throws: a store that fails here leaves the reservation to the sweeper.
 */
async function settleAndTrace(deps: GatewayDeps, runtime: GatewayRuntime, policy: CompiledPolicy, held: Held, outcome: RequestOutcome): Promise<void> {
  const o: RequestOutcome = { ...outcome };
  o.costModifiers = requestModifiers(policy, o.features);
  const r = o.usage;
  const model = r?.responseModel ?? held.plan?.chain[0]?.upstreamModel ?? o.features.model;
  let cost: number | null = null;
  let costFailed = false;
  if (r?.usage && model) {
    try {
      cost = actualCost(policy, model, { ...r, usage: r.usage }, o.features);
    } catch {
      costFailed = true; // unpriced model or fast mode, an invalid cost: fail closed below
    }
  } else if (o.provider !== null && o.status >= 200 && o.status < 300 && !held.streamed) {
    // A successful JSON answer was billed even when its usage cannot be read: cut off by the upstream or by a client
    // abort, unparsable, larger than the cap, or without a usage object. Fail closed: the estimate stands.
    costFailed = true;
  }
  if (held.admitted) {
    held.settled = true;
    let actual = cost ?? 0;
    if (costFailed) {
      actual = held.est;
      o.settledAtEstimate = true;
    }
    o.costMicroUsd = actual;
    o.overrun = (held.plan?.reservations.length ?? 0) > 0 && actual > held.est;
    let result: 'settled' | 'unknown' | 'failed';
    try {
      result = await withDeadline((deps.store as CounterStore).settle(o.id, actual), deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS);
    } catch {
      result = 'failed'; // the record stays; the sweeper settles it at the estimate
    }
    // Swept here (onSwept), or the record was already gone ('unknown': swept by another instance), or it is left for
    // the sweeper ('failed'): in each case the sweeper settles it at its estimate.
    const swept = runtime.takeSwept(o.id);
    o.settledBy = swept || result !== 'settled' ? 'sweeper' : 'request';
    // What the budget counters were charged: the sweeper always settles at the estimate. Warm-up seeds this.
    o.chargedMicroUsd = o.settledBy === 'sweeper' ? held.est : actual;
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

/**
 * Step 5 (spec 5.3, 6.6): secret rules on every route, PII rules on product routes only; and for product routes, the
 * byte ranges a `redact` action replaces, over the whole body (a product client resends its history unredacted).
 * A body JSON.parse refused, or one with duplicate keys a provider may read differently, has no structure to trust:
 * all of it counts as the last turn, and its raw bytes and a decoded copy of them are scanned.
 */
function scanGuardrails(policy: CompiledPolicy, product: boolean, body: Buffer, x: ExtractedFeatures, salt: string): { hits: GuardrailHit[]; redactions: RedactionHit[] } {
  const g = policy.guardrails;
  const untrusted = x.parseError || x.ambiguousKeys === true;
  const lastTurn = untrusted ? { start: 0, end: body.length } : x.lastTurn;
  const opts = { ...(x.messages && !untrusted ? { messages: x.messages } : {}), raw: untrusted };
  const hits = scanBody(body, lastTurn, DEFAULT_RULES, () => (product ? g.secrets.product : g.secrets.codingAgent), salt, opts);
  if (!product) return { hits, redactions: [] };
  hits.push(...scanBody(body, lastTurn, PII_RULES, () => g.pii.product, salt, { ...opts, quotedOnly: g.pii.quotedOnly }));
  const redactRules = [...(g.secrets.product === 'redact' ? DEFAULT_RULES.filter((r) => !r.entropyOnly) : []), ...(g.pii.product === 'redact' ? PII_RULES : [])];
  const redactions = redactionHits(findSpans(body, redactRules, { ...opts, quotedOnly: g.pii.quotedOnly }));
  return { hits, redactions };
}

const isJson = (b: Buffer): boolean => {
  try {
    JSON.parse(b.toString('utf8'));
    return true;
  } catch {
    return false;
  }
};

const NO_FEATURES: ExtractedFeatures = {
  model: null, stream: false, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], bodyBytes: 0,
  prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: false, lastTurn: null,
};

async function handle(deps: GatewayDeps, failure: FailureState, runtime: GatewayRuntime, held: Held, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  // `held` is what this request holds in the counter store; every exit below settles it before the trace is queued,
  // and createHandler settles it if handle() throws instead.

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

  // 5. Guardrails: before admit, no store call; only HMACs of matched values leave the scan.
  const product = key.kind === 'service';
  const guard = scanGuardrails(policy, product, body, features, deps.guardrailSalt ?? deps.traceSalt ?? '');

  // 6. Decide. A reservation that cannot be priced (the estimator throws) fails closed: refused before admit, so nothing
  // is reserved.
  let f: RequestFeatures;
  let plan: Plan;
  try {
    f = buildFeatures(features, key, pseudonymised(readAttribution(req.headers, surface), deps.traceSalt), guard.hits, policy.prices, id, startedAt, surface, { bytesBoundOff: runtime.bytesBoundOff });
    plan = decide(policy, f);
  } catch {
    sendError(req, res, anthropicError(500, 'api_error', 'the reservation for this request could not be computed; it was not sent', null, id));
    return early({ features, guardrailHits: guard.hits, status: 500, decision: { action: 'block', reason: 'reservation-error' }, errorClass: 'reservation_error' });
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
    guardrailHits: guard.hits,
    ...(candidate ? { candidate } : {}),
  };
  const first = plan.chain[0];

  // rewriteModel (product routes, or coding-agent routes behind allowBodyRewrite): only the bytes of the top-level
  // model value change; the reservation is priced at this served model. Not locatable exactly: refuse, never guess.
  // Decided before admission, so a request that cannot be sent never reserves anything.
  let upstreamBody = body;
  // Redaction (product routes only, spec 6.6): matched values become placeholders; the HTTP client sets the new
  // content-length. Coding-agent bodies are never touched. A result that is not JSON is refused, never sent.
  if (plan.preBlock === null && product && guard.redactions.length > 0) {
    const redacted = redactProductBody(body, guard.redactions);
    if (!features.parseError && !isJson(redacted)) {
      sendError(req, res, anthropicError(400, 'invalid_request_error', 'a redacted value could not be replaced without breaking the JSON body; it was not sent', null, id));
      return early({ ...decided, status: 400, decision: { action: 'block', reason: 'redaction-failed' }, errorClass: 'invalid_request_error' });
    }
    upstreamBody = redacted;
  }
  if (plan.preBlock === null && first?.rewritesModel) {
    const rewritten = rewriteTopLevelModel(upstreamBody, first.upstreamModel);
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
  const { pre, callsAdmit } = planAdmission(policy, plan);
  let admission: Admission | null = null;
  let admitAt: RequestOutcome['admitAt'];
  if (deps.store !== null && callsAdmit) {
    const store = deps.store;
    admitAt = { offsetMs: Math.max(0, deps.clock() - startedAt), seq: ++runtime.admits };
    const pending = store.admit(plan);
    try {
      admission = await withDeadline(pending, deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS);
    } catch {
      admission = { admitted: false, failed: null, audit: [], totals: [], storeDown: true };
      // An admit that lands after the deadline reserved for a request handled as store-down: release it at once.
      pending.then((late) => (late.admitted ? store.settle(id, 0) : undefined)).catch(() => undefined);
    }
  }
  held.admitted = isAdmitted(plan, admission);
  held.est = held.admitted ? (plan.reservations[0]?.estMicroUsd ?? 0) : 0;
  const admitted = {
    reservedMicroUsd: held.est,
    ...(admission ? { audit: admission.audit } : {}),
    ...(admission?.storeDown ? { storeDown: true, taintUnchecked: plan.taint !== null } : {}),
    ...(admitAt ? { admitAt } : {}),
  };
  if (held.admitted) {
    held.known = {
      id,
      key,
      attribution: readAttribution(req.headers, surface),
      surface,
      ...decided,
      ...admitted,
      provider: first?.provider ?? null,
      startedAt,
      costBasis: key.billing === 'subscription' ? 'api-equivalent' : 'billed',
      client: parseClient(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined),
      policyRevision: policy.revision,
      priceTable: policy.priceTableVersion,
    };
  }

  // 8. Resolve.
  const decision = admission === null ? pre : resolve(policy, plan, admission);
  const provider = first === undefined ? undefined : policy.providers.get(first.provider);
  if (decision.block || !provider) {
    const b = decision.block ?? { status: 403 as const, type: 'permission_error', reason: 'no-route' as const, message: 'no provider serves this route', retryAfterS: null };
    sendError(req, res, anthropicError(b.status, b.type, b.message, b.retryAfterS, id, retryable(b.reason) ? {} : { shouldRetry: false }));
    return early({ ...decided, ...admitted, status: b.status, decision: { action: 'block', reason: b.reason }, errorClass: b.type });
  }

  // 9. Forward: the chain tries providers until one answers usably, and only before any byte reaches the client (spec 8).
  // A tokenyard key is never forwarded, in whichever header it came; any other Authorization (the OAuth token) is.
  const headersFor = (p: ProviderSpec): Record<string, string | string[]> =>
    upstreamHeaders(req.headers, {
      mode: p.credential === 'passthrough' ? 'passthrough' : 'api',
      credential: providerCredential(p, deps.env ?? process.env),
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

export function createHandler(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  if (deps.traces && !deps.traceSalt) throw new Error('traces need a traceSalt: session and agent ids are HMAC pseudonyms (spec 9.1)');
  if (!deps.guardrailSalt) deps = { ...deps, guardrailSalt: deps.traceSalt ?? randomBytes(16).toString('hex') };
  const runtime = deps.runtime ?? createGatewayRuntime();
  const admitTimeoutMs = deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS;
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
    const held: Held = { plan: null, features: null, admitted: false, est: 0, streamed: false, settled: false, known: null };
    handle(deps, failureState(deps.policy()), runtime, held, id, req, res).catch(() => {
      // A fault after admit must not hold the reservation and the stream slot until the sweep: settle at the estimate
      // (whether upstream billed is unknown, so fail closed), and queue the trace line with that charge so warm-up
      // (and the live cap across runs) counts it.
      if (held.admitted && !held.settled && deps.store) {
        held.settled = true;
        const known = held.known;
        void withDeadline(deps.store.settle(id, held.est), admitTimeoutMs)
          .then((r) => r === 'settled', () => false)
          .then((settled) => {
            if (known === null || !deps.traces) return;
            const swept = runtime.takeSwept(id) || !settled;
            let now = known.startedAt;
            try {
              now = deps.clock();
            } catch {
              // the clock is what failed; the line still goes out
            }
            deps.traces.write(
              buildTraceRecord(
                {
                  ...known,
                  status: 500,
                  usage: null,
                  aborted: false,
                  ttfbMs: null,
                  totalMs: Math.max(0, now - known.startedAt),
                  costMicroUsd: held.est,
                  addedTtfbMs: null,
                  errorClass: 'internal_error',
                  settledAtEstimate: true,
                  settledBy: swept ? 'sweeper' : 'request',
                  chargedMicroUsd: held.est,
                  overrun: false,
                },
                deps.traceSalt ?? '',
              ),
            );
          })
          .catch(() => undefined);
      }
      try {
        if (!res.headersSent) sendError(req, res, anthropicError(500, 'api_error', 'internal error', null, id));
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  };
}
