import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReservedRecord, TraceRecord } from '../ledger/record.js';
import type { CounterStore } from '../limits/store.js';
import { guardrailKey, pseudonym } from '../guardrails/hmac.js';
import { redactCredentialEcho } from '../guardrails/credential-echo.js';
import { PII_RULES } from '../guardrails/pii.js';
import { type RedactionHit, redactionHits, redactProductBody } from '../guardrails/redact.js';
import { DEFAULT_RULES } from '../guardrails/rules.js';
import { countEscapesUpTo, findSpans, SCAN_ESCAPE_BUDGET, ScanBudgetError, scanBody } from '../guardrails/scan.js';
import { buildFeatures, decide, enforcedLevelApplies } from '../policy/decide.js';
import { bodyShapeRefusal } from '../surfaces/body-shape.js';
import { BODY_VALUE_BUDGET, countJsonValuesUpTo } from '../surfaces/json-ranges.js';
import { modelsForKey } from '../policy/match.js';
import { atEstimateCharge, isAdmitted, planAdmission } from '../policy/admission.js';
import { resolve } from '../policy/resolve.js';
import type { Admission, CompiledPolicy, Decision, GuardrailHit, KeyRecord, Plan, ProviderSpec, RequestFeatures, Surface } from '../policy/types.js';
import { billedServiceTier, costMicroUsd } from '../pricing/cost.js';
import { AnthropicUsageAccumulator, parseAnthropicJsonUsage, type UsageResult } from '../stream/anthropic-usage.js';
import { COUNTED_RESPONSES_CALLS, parseResponsesJsonUsage, ResponsesUsageAccumulator } from '../stream/responses-usage.js';
import { serverToolKey } from '../limits/estimator.js';
import { serverToolFormat, serverToolPrice } from '../pricing/prices.js';
import { SseParser } from '../stream/sse.js';
import { createTee } from '../stream/tee.js';
import { extractCountTokensFeatures } from '../surfaces/anthropic-count-tokens.js';
import { capTopLevelInteger, extractAnthropicFeatures, rewriteTopLevelModel } from '../surfaces/anthropic-messages.js';
import { modelsListBody } from '../surfaces/anthropic-models.js';
import { extractResponsesFeatures } from '../surfaces/openai-responses.js';
import type { ExtractedFeatures } from '../surfaces/types.js';
import { Breaker } from '../upstream/breaker.js';
import { type AttemptInfo, ChainError, runChain, workspaceOf } from '../upstream/chain.js';
import type { UpstreamResponse } from '../upstream/forward.js';
import { RetryBudget } from '../upstream/retry-budget.js';
import { readAttribution, type RawAttribution } from './attribution.js';
import { extractCredentials, hashKey } from './auth.js';
import { BodyTooLargeError, readBody } from './body.js';
import { anthropicError, type ErrorEnvelope, type ErrorReply, ownError, retryable } from './errors.js';
import { clientHeaders, upstreamHeaders } from './headers.js';
import { createRequestRecorder, type Metrics, modelLabel } from '../telemetry/metrics.js';
import type { SpanSink } from '../telemetry/otel.js';
import { matchOps, serveOps } from './ops.js';
import { matchRoute } from './paths.js';
import { buildTraceRecord, parseClient } from './trace-record.js';

/** Where finished request records go. Implemented by `TraceWriter`; `null` when `--trace-dir` is not set. */
export interface TraceSink {
  write(r: Omit<TraceRecord, 'instance' | 'seq'>): boolean;
  /**
   * Write-ahead line for an admitted request (A11): resolves true once it is written; the request is forwarded only
   * then, and refused (503) when it resolves false. Sinks without it skip it.
   */
  reserved?(r: Omit<ReservedRecord, 'v' | 'kind' | 'instance'>): Promise<boolean>;
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
   * HMAC key for secret values (session taint, trace hits). Defaults to HMAC(traceSalt, "guardrail") (B8), else a random
   * key per process: then taint written by one instance is not recognised by another sharing the same Redis.
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
  /** Prometheus metrics (spec 12.2). Served at /metrics on this port unless `metricsOnOtherPort` is set. */
  metrics?: Metrics;
  /** OTel span sink (spec 12.2); like traces it needs a `traceSalt`, since spans carry the pseudonyms. */
  spans?: SpanSink;
  /**
   * Total time one request may take, from arrival to its last byte (default DEFAULT_REQUEST_DEADLINE_MS). It must stay
   * below the store's reservation deadline, so the sweeper never frees the slot of a request that is still running.
   */
  requestDeadlineMs?: number;
  /** Bearer token for /metrics on the ops listener (`createGateway().listenOps`). /metrics is never served on this API port. */
  metricsToken?: string;
  /** Idle time before the API listener closes a keep-alive connection (default Node's 5 s; Node adds 1 s before it acts). */
  keepAliveTimeoutMs?: number;
}

export const DEFAULT_ADMIT_TIMEOUT_MS = 1_000;
/** How long a write-ahead trace line may take to reach disk before the request is refused (A11, live harness). */
const WRITE_AHEAD_TIMEOUT_MS = 5_000;
/**
 * 18 minutes: above Claude Code's 10 minute request timeout, below the 20 minute reservation deadline (spec 7.2), with
 * time left to settle. undici's own timeouts only bound idle gaps, so a stream that keeps sending needs this (A8).
 */
export const DEFAULT_REQUEST_DEADLINE_MS = 18 * 60_000;

class StoreTimeoutError extends Error {}

const recorders = new WeakMap<Metrics, ReturnType<typeof createRequestRecorder>>();

/** Metrics and spans from the finished request's record. Never throws: telemetry must not turn a served request into an error. */
function emitTelemetry(deps: GatewayDeps, policy: CompiledPolicy, rec: Omit<TraceRecord, 'instance' | 'seq'>, attempts?: AttemptInfo[]): void {
  try {
    if (deps.metrics) {
      let record = recorders.get(deps.metrics);
      if (!record) recorders.set(deps.metrics, (record = createRequestRecorder(deps.metrics)));
      record(rec, policy.prices);
    }
    deps.spans?.requestSpan(rec, attempts, modelLabel(policy.prices, rec.features.model));
  } catch {
    // dropped on purpose
  }
}

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
  /**
   * R11: set when a settled request billed more input than its bytes bound, here or (through the store's shared latch,
   * A9) on any instance; every later request uses the context-window bound.
   */
  bytesBoundOff: boolean;
  /** When this process last read the store's R11 latch (ms, its clock); null before the first read. */
  latchReadAt: number | null;
  /** Requests whose billed input exceeded their bytes bound (a counter for /metrics). */
  boundViolations: number;
  /** Admit calls made by this process, in call order; each request's number is traced so replay can order admits that share a millisecond. */
  admits: number;
  /**
   * A random id of this process (16 hex characters), traced on every record as `decision.seqEpoch`: `admits` starts at
   * 0 in each process while `--instance-id` may be reused across restarts, so replay compares admit and settle counts
   * only within one (instance, epoch) (V4 review I1).
   */
  readonly epoch: string;
  /** Ids the sweeper settled at their estimate (pass as the store's `onSwept`); never throws. */
  onSwept(ids: string[]): void;
  /** Whether the sweeper settled this request; forgets the id. */
  takeSwept(id: string): boolean;
}

/** How often a process re-reads the store's R11 latch in the background once it has read it (A9). */
export const LATCH_REFRESH_MS = 30_000;

/**
 * The store's R11 latch (A9): the first request of a process waits for one read (bounded by the admit deadline), so a
 * restarted or second instance never decides with a bytes bound another one has shown to fail; later reads run in the
 * background every LATCH_REFRESH_MS and keep the hot path at one store round trip. A store that cannot answer leaves
 * the process latch as it is.
 */
async function readLatch(deps: GatewayDeps, runtime: GatewayRuntime): Promise<void> {
  const store = deps.store;
  if (runtime.bytesBoundOff || !store?.boundOffLatched) return;
  const now = deps.clock();
  const first = runtime.latchReadAt === null;
  if (!first && now - (runtime.latchReadAt as number) < LATCH_REFRESH_MS) return;
  runtime.latchReadAt = now;
  const read = withDeadline(store.boundOffLatched(), deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS).then(
    (on) => void (on && (runtime.bytesBoundOff = true)),
    () => undefined,
  );
  if (first) await read;
}

/** Ids remembered for requests the sweeper settled; a request that never comes back must not grow it without end. */
const SWEPT_MAX = 100_000;

/** `epoch` fixes the process id (the demo, for byte-identical traces); by default it is random. */
export function createGatewayRuntime(o: { epoch?: string } = {}): GatewayRuntime {
  const swept = new Set<string>();
  return {
    bytesBoundOff: false,
    latchReadAt: null,
    boundViolations: 0,
    admits: 0,
    epoch: o.epoch ?? randomBytes(8).toString('hex'),
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
  /** Admits this process had issued when it called settle: replay orders the release against them (V4). */
  settleSeq?: number;
  /** The process's `GatewayRuntime.epoch`: admitSeq and settleSeq count within it. */
  seqEpoch?: string;
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
  /** Upstream attempts as the forwarder saw them (spans only; not part of the trace record). */
  attemptLog?: AttemptInfo[];
}

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

/** At most this much of a non-2xx body reaches the client in API mode, all of it redacted (B2, S25-3). */
const ERROR_BODY_CAP_BYTES = 64 * 1024;
const TRUNCATED_MARKER = '\n[truncated by tokenyard]';

/** The first `cap` bytes of `s` or more (or all of it, `ended`); the rest of `s` is left unread. */
function readUpTo(s: Readable, cap: number): Promise<{ bytes: Buffer; ended: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const done = (ended: boolean): void => {
      s.off('data', onData);
      s.off('end', onEnd);
      s.off('error', onEnd);
      resolve({ bytes: Buffer.concat(chunks), ended });
    };
    const onData = (c: Buffer): void => {
      chunks.push(c);
      n += c.length;
      if (n >= cap) done(false);
    };
    const onEnd = (): void => done(true);
    s.on('data', onData);
    s.once('end', onEnd);
    s.once('error', onEnd);
  });
}

/**
 * The body to send the client. In API mode every client shares the operator's key, so a non-2xx answer that quotes it
 * (a 401 echoing the header, OpenAI's masked `sk-proj-****WXYZ`) is cut to 64 KiB with a marker and has the key and its
 * masked forms replaced in everything forwarded; `headers` gets the new content-length (B2, S25-3). Bytes past the cut
 * are read so the redaction sees a key or masked form that straddles it whole, then dropped. Such an answer with a
 * content-encoding other than identity becomes tokenyard's own error with the same status. Everything else is the
 * upstream stream, untouched.
 */
async function withoutCredentialEcho(up: UpstreamResponse, p: ProviderSpec, env: NodeJS.ProcessEnv, headers: Record<string, string | string[]>, envelope: ErrorEnvelope): Promise<Readable> {
  if (p.credential === 'passthrough' || (up.status >= 200 && up.status < 300)) return up.body;
  // Redaction cannot read compressed bytes (the gateway asked for identity, a provider or proxy may still compress): the
  // error is replaced by tokenyard's own, with the upstream status.
  const encoding = String(headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity' && encoding !== '') {
    up.body.on('error', () => undefined);
    up.body.destroy();
    const message = `tokenyard: upstream answered ${up.status} with a ${encoding.replace(/[^a-z0-9,-]/g, '').slice(0, 32)}-encoded body, withheld because it could not be checked for the provider key`;
    const body = Buffer.from(
      JSON.stringify(envelope === 'openai' ? { error: { type: 'server_error', code: 'upstream_error_encoded', message } } : { type: 'error', error: { type: 'api_error', message } }),
    );
    delete headers['content-encoding'];
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
    return Readable.from([body]);
  }
  const key = env[p.credential.env];
  if (!key) return up.body;
  // Margin past the cap: a key, or a masked form (look-back of at most the key's length, a mask of at most 64), that
  // starts before the cut ends inside it.
  const head = await readUpTo(up.body, ERROR_BODY_CAP_BYTES + 2 * key.length + 128);
  if (!head.ended) {
    up.body.on('error', () => undefined);
    up.body.destroy();
  }
  let out = redactCredentialEcho(head.bytes, key) ?? head.bytes;
  if (!head.ended || out.length > ERROR_BODY_CAP_BYTES) out = Buffer.concat([out.subarray(0, ERROR_BODY_CAP_BYTES), Buffer.from(TRUNCATED_MARKER)]);
  headers['content-length'] = String(out.length);
  return Readable.from([out]);
}

function extractFeatures(surface: Surface, body: Buffer): ExtractedFeatures {
  if (surface === 'anthropic-count-tokens') return extractCountTokensFeatures(body);
  if (surface === 'openai-responses') return extractResponsesFeatures(body);
  return extractAnthropicFeatures(body);
}

/** Watches the response bytes for usage without delaying or changing them (spec 5.3 step 11, 5.4). */
function usageTap(surface: Surface, up: UpstreamResponse, capBytes: number): { onChunk(c: Buffer): void; result(): UsageResult | null } {
  if (surface !== 'anthropic-messages' && surface !== 'openai-responses') return { onChunk: () => undefined, result: () => null };
  const responses = surface === 'openai-responses';
  const ct = String(up.headers['content-type'] ?? '');
  if (ct.startsWith('text/event-stream')) {
    const parser = new SseParser();
    const acc = responses ? new ResponsesUsageAccumulator() : new AnthropicUsageAccumulator();
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
    result: () => (size <= capBytes ? (responses ? parseResponsesJsonUsage : parseAnthropicJsonUsage)(Buffer.concat(chunks)) : null),
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
  /** Settlement has started; the fault path in `createHandler` settles an admitted request that never got here. */
  settled: boolean;
  /** The upstream may have billed without any usage coming back (the body was sent, then the attempt failed or the
   * client left): settle at the reservation, never at 0 (A6). */
  chargeReservation: boolean;
  /** The surface's error envelope for own errors, the fault path's included. */
  envelope: ErrorEnvelope;
  /** What the request knew once admitted, so the fault path can still queue its trace line (warm-up reads the charge). */
  known: Omit<RequestOutcome, 'status' | 'usage' | 'aborted' | 'ttfbMs' | 'totalMs' | 'costMicroUsd' | 'addedTtfbMs'> | null;
}

/**
 * Prompt tokens the provider counted, for R11. On the Responses surface cache writes are billed on top of
 * `input_tokens` (ruling), so they are not prompt tokens of their own.
 */
const totalInput = (u: NonNullable<UsageResult['usage']>, surface: Surface): number =>
  u.input + u.cacheRead + (surface === 'openai-responses' ? 0 : u.cacheWrite5m + u.cacheWrite1h);

/**
 * Price table modifiers the request was billed with: `inference_geo: "us"` is `inferenceGeoUs`; a geo without an entry
 * has none. The geo the response reports wins over the request's (a workspace `default_inference_geo` applies to
 * requests that name none); the reservation already assumes every modifier above 1.
 */
function requestModifiers(policy: CompiledPolicy, x: ExtractedFeatures, r: UsageResult | null): string[] {
  const reported = r?.inferenceGeo ?? x.inferenceGeo;
  if (reported === undefined || reported === '') return [];
  const geo = reported.toLowerCase();
  const name = `inferenceGeo${geo.charAt(0).toUpperCase()}${geo.slice(1)}`;
  return Object.hasOwn(policy.prices.modifiers, name) ? [name] : [];
}

/**
 * Actual cost from the usage (spec 7.6): fast mode from the response or the request, the request's modifiers, server
 * tool uses. Throws when it cannot be priced.
 */
function actualCost(policy: CompiledPolicy, model: string, r: UsageResult & { usage: NonNullable<UsageResult['usage']> }, x: ExtractedFeatures, surface: Surface): number {
  return costMicroUsd(policy.prices, model, r.usage, {
    fast: r.fast === true || x.fastMode,
    // The tier the response reports it was served on, else the one asked for (`auto` with no answer throws: estimate).
    serviceTier: billedServiceTier(r, x) ?? null,
    modifiers: requestModifiers(policy, x, r),
    ...(r.serverToolUses ? { serverToolUses: r.serverToolUses, serverToolFormat: serverToolFormat(surface) } : {}),
  });
}

/**
 * A Responses request with a priced server tool whose calls the usage parser does not count (only the types in
 * COUNTED_RESPONSES_CALLS are): its per-call fees would go uncharged, so it settles at the reservation (A2-3).
 */
function uncountedToolFees(policy: CompiledPolicy, surface: Surface, f: RequestFeatures | null): boolean {
  if (surface !== 'openai-responses' || f === null) return false;
  const counted = new Set(Object.values(COUNTED_RESPONSES_CALLS));
  return f.serverTools.some((tool) => {
    const name = serverToolKey(tool.type);
    return !counted.has(name) && (serverToolPrice(policy.prices, 'openai', name)?.perUseUsd ?? 0) > 0;
  });
}

/**
 * After `res.end()`: price the usage, settle the reservation (which also frees the stream slots), then queue the trace
 * (never waits on disk). Never throws: a store that fails here leaves the reservation to the sweeper.
 */
async function settleAndTrace(deps: GatewayDeps, runtime: GatewayRuntime, policy: CompiledPolicy, held: Held, outcome: RequestOutcome): Promise<void> {
  const o: RequestOutcome = { ...outcome };
  o.costModifiers = requestModifiers(policy, o.features, o.usage);
  const r = o.usage;
  const model = r?.responseModel ?? held.plan?.chain[0]?.upstreamModel ?? o.features.model;
  let cost: number | null = null;
  let costFailed = false;
  // A Messages stream that ended without its final usage (no message_delta usage: aborted, cut, or a message_stop
  // without it) settles at the full reservation, as a Responses stream does (S20-2): streamed characters bound no
  // output (summarized or redacted thinking, CJK), and with compaction or a server-tool loop most billed input arrives
  // only in the final message_delta (usage.iterations), so message_start's input bounds nothing either (A3).
  if (held.chargeReservation) costFailed = true;
  if (uncountedToolFees(policy, o.surface, held.features)) costFailed = true;
  if (r?.usage && o.surface === 'anthropic-messages' && (r.source === 'estimated' || r.outputEstimated === true)) costFailed = true;
  if (costFailed) {
    // the estimate stands (below)
  } else if (r?.usage && model) {
    try {
      cost = actualCost(policy, model, { ...r, usage: r.usage }, o.features, o.surface);
    } catch {
      costFailed = true; // unpriced model or fast mode, an invalid cost: fail closed below
    }
  } else if (o.provider !== null && o.status >= 200 && o.status < 300) {
    // A successful answer may have been billed even when no usage can be read: a JSON body cut off, unparsable, larger
    // than the cap or without a usage object; a stream that ended before message_start, or a Responses stream without
    // terminal usage (ruling S20-2). Fail closed: the estimate stands.
    costFailed = true;
  }
  if (held.admitted) {
    held.settled = true;
    deps.metrics?.inc('tokenyard_reservations_open', {}, -1);
    let actual = cost ?? 0;
    if (costFailed) {
      actual = atEstimateCharge(held.plan, held.est);
      o.settledAtEstimate = true;
    }
    o.costMicroUsd = actual;
    o.overrun = (held.plan?.reservations.length ?? 0) > 0 && actual > held.est;
    let result: 'settled' | 'unknown' | 'failed';
    // totalMs was measured before this call, so a later admit can share its millisecond; the count orders them.
    o.settleSeq = runtime.admits;
    try {
      result = await withDeadline((deps.store as CounterStore).settle(o.id, actual), deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS);
    } catch {
      result = 'failed'; // the record stays; the sweeper settles it at the estimate
      deps.metrics?.inc('tokenyard_store_down_total', { op: 'settle' });
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

  // R11: the bytes bound rests on at most one token per byte; one violation turns it off for this process and, through
  // the store's latch, for every instance on the store until the latch key is deleted (A9).
  const f = held.features;
  if (r?.usage && f?.boundKind === 'bytes' && totalInput(r.usage, o.surface) > f.inputTokensBound) {
    o.boundExceeded = true;
    runtime.boundViolations++;
    deps.metrics?.inc('tokenyard_bound_violations_total');
    if (!runtime.bytesBoundOff) {
      runtime.bytesBoundOff = true;
      // Shared with every instance on the store, and kept across restarts (A9).
      if (deps.store?.latchBoundOff) await withDeadline(deps.store.latchBoundOff(), deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS).catch(() => undefined);
      console.error(`tokenyard: request ${o.id} billed ${totalInput(r.usage, o.surface)} input tokens, above its bytes bound of ${f.inputTokensBound}; the bytes bound is off (context-window bound for every request) on every instance sharing this counter store until the key ty:{_global}:r11 is deleted`);
    }
  }
  try {
    deps.onSettled?.(o);
    if (deps.traces || deps.metrics || deps.spans) {
      const rec = buildTraceRecord({ ...o, seqEpoch: runtime.epoch }, deps.traceSalt ?? '', policy);
      emitTelemetry(deps, policy, rec, o.attemptLog);
      deps.traces?.write(rec);
    }
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
  // PII hits carry no value HMAC: a PESEL or an address is few enough guesses to enumerate (B8); they never taint.
  hits.push(...scanBody(body, lastTurn, PII_RULES, () => g.pii.product, salt, { ...opts, quotedOnly: g.pii.quotedOnly, valueHmac: false }));
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
  // A8: a request that outlives this deadline is aborted upstream and settles at its reservation, before the sweeper
  // could free its slot while it still runs.
  let deadlineHit = false;
  const deadline = setTimeout(() => {
    deadlineHit = true;
    held.chargeReservation = true;
    ac.abort();
  }, deps.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS);
  deadline.unref?.();
  res.on('close', () => {
    clearTimeout(deadline);
    if (!res.writableFinished) ac.abort();
  });

  // 1. Accept.
  const method = req.method ?? 'GET';
  const match = matchRoute(method, req.url ?? '/', deps.basePath);
  if (!match) {
    const path = (req.url ?? '/').split('?')[0];
    return sendError(req, res, anthropicError(404, 'not_found_error', `no route for ${method} ${path}`, null, id));
  }
  const envelope: ErrorEnvelope = match.surface === 'openai-responses' ? 'openai' : 'anthropic';
  held.envelope = envelope;
  const own = (status: number, type: string, reason: string, message: string, retryAfterS: number | null = null, opts: { shouldRetry?: boolean } = {}): ErrorReply => {
    if (opts.shouldRetry === false) deps.metrics?.inc('tokenyard_should_retry_refusals_total', { reason });
    return ownError(envelope, status, type, reason, message, retryAfterS, id, opts);
  };
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
    return sendError(req, res, own(401, 'authentication_error', 'unknown-key', 'missing or unknown tokenyard key'));
  }
  if (key.billing === 'subscription' && !deps.experimentalSubscription) {
    return sendError(req, res, own(401, 'authentication_error', 'subscription-disabled', 'subscription keys are not enabled on this gateway'));
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

  // A compressed or otherwise encoded body would be forwarded opaque while the gateway priced nothing it could read (A5).
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity' && String(encoding).trim() !== '') {
    sendError(req, res, own(400, 'invalid_request_error', 'content-encoding', 'request bodies must not be encoded (Content-Encoding other than identity); send it uncompressed', null, { shouldRetry: false }), true);
    return early({ status: 400, decision: { action: 'block', reason: 'content-encoding' }, errorClass: 'invalid_request_error' });
  }

  // A8: the request deadline fired while the client still waits for headers: answered 504, charged at the reservation.
  const deadlineExit = (over: Partial<RequestOutcome>): Promise<void> => {
    sendError(req, res, own(504, 'timeout_error', 'request-deadline', `the request did not finish within ${Math.round((deps.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS) / 1000)} s`, null, { shouldRetry: false }));
    return early({ ...over, status: 504, errorClass: 'request_deadline' });
  };

  // 3. Read the body.
  let body: Buffer;
  try {
    body = await readBody(req, deps.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      const msg = `request body is larger than the ${err.capBytes} byte limit`;
      sendError(req, res, own(413, 'request_too_large', 'request_too_large', msg), true);
      return early({ status: 413, decision: { action: 'block', reason: 'body-too-large' }, errorClass: 'request_too_large' });
    }
    return early({ status: 499, aborted: true, errorClass: 'client_abort' }); // the client went away mid-upload
  }

  await readLatch(deps, runtime);

  // Scan budget (S-V3-1, S-V3-3), before the body is parsed: parsing and the secret scan cost per JSON value and per
  // escape, not per byte, so a body holding more of either than the budget is refused before JSON.parse allocates
  // them. The whole body counts: the scanner decodes it whole whenever a rule blocks (history rules), on product routes
  // (redaction), for a body that cannot be trusted and when there is no last turn.
  const scanBudgetExit = (msg: string, features?: ExtractedFeatures): Promise<void> => {
    sendError(req, res, own(413, 'request_too_large', 'scan-budget', msg, null, { shouldRetry: false }));
    return early({ ...(features ? { features } : {}), status: 413, decision: { action: 'block', reason: 'scan-budget' }, errorClass: 'request_too_large' });
  };
  if (countEscapesUpTo(body, { start: 0, end: body.length }, SCAN_ESCAPE_BUDGET) > SCAN_ESCAPE_BUDGET) {
    return scanBudgetExit(`the request body holds more than ${SCAN_ESCAPE_BUDGET} JSON escape sequences, more than tokenyard scans for secrets; send the text unescaped where JSON allows it, or split the request`);
  }
  if (countJsonValuesUpTo(body, BODY_VALUE_BUDGET) > BODY_VALUE_BUDGET) {
    return scanBudgetExit(`the request body holds more than ${BODY_VALUE_BUDGET} JSON values (strings, numbers, objects, arrays), more than tokenyard parses and scans for secrets; send long lists as one string, or split the request`);
  }

  // 4. Extract features (read-only; the body Buffer is forwarded as received).
  const features = extractFeatures(surface, body);

  // 5. Guardrails: before admit, no store call; only HMACs of matched values leave the scan. The scan stops at its work
  // budget (decoded runs, rule matches; S-V3-3) and the body is refused, never sent unscanned.
  const product = key.kind === 'service';
  let guard: ReturnType<typeof scanGuardrails>;
  try {
    guard = scanGuardrails(policy, product, body, features, deps.guardrailSalt ?? '');
  } catch (err) {
    if (!(err instanceof ScanBudgetError)) throw err;
    const what = err.counter === 'runs' ? `${err.limit} decoded string pieces` : `${err.limit} secret or PII rule matches`;
    return scanBudgetExit(`the request body needs more than ${what} to scan for secrets, more than tokenyard scans; split the request`, features);
  }

  // 6. Decide. A reservation that cannot be priced (the estimator throws) fails closed: refused before admit, so nothing
  // is reserved.
  const featuresFor = (x: ExtractedFeatures): RequestFeatures =>
    buildFeatures(x, key, pseudonymised(readAttribution(req.headers, surface), deps.traceSalt), guard.hits, policy.prices, id, startedAt, surface, { bytesBoundOff: runtime.bytesBoundOff });
  let f: RequestFeatures;
  let plan: Plan;
  try {
    f = featuresFor(features);
    // Bodies another parser may read differently than JSON.parse did (A5, C7): a BOM, duplicate keys, and, when an
    // enforced budget applies to a billed surface, JSON that does not parse. A last-turn secret is still answered as one.
    const shape = bodyShapeRefusal(body, !features.parseError);
    const unreadable = features.parseError && surface !== 'anthropic-count-tokens' && enforcedLevelApplies(policy, f);
    const secret = guard.hits.some((h) => h.action === 'block' && h.where === 'last-turn');
    if (!secret && (shape !== null || unreadable)) {
      const reason = shape ?? 'unparsable-body';
      const msg =
        reason === 'body-bom' ? 'the request body starts with a byte order mark; send plain UTF-8 JSON'
        : reason === 'duplicate-keys' ? 'the request body repeats a key inside one JSON object; send each key once'
        : reason === 'too-deep' ? 'the request body nests objects or arrays too deeply'
        : 'the request body is not valid JSON, and this request touches an enforced budget, so it cannot be priced; it was not sent';
      sendError(req, res, own(400, 'invalid_request_error', reason, msg, null, { shouldRetry: false }));
      return early({ features, guardrailHits: guard.hits, status: 400, decision: { action: 'block', reason }, errorClass: 'invalid_request_error' });
    }
    plan = decide(policy, f);
  } catch {
    sendError(req, res, own(500, 'api_error', 'reservation-error', 'the reservation for this request could not be computed; it was not sent'));
    return early({ features, guardrailHits: guard.hits, status: 500, decision: { action: 'block', reason: 'reservation-error' }, errorClass: 'reservation_error' });
  }
  held.plan = plan;
  held.features = f;
  const cp = policy.candidate;
  const candidate = cp ? auditCandidate(cp, f) : undefined;
  const chainNames = plan.chain.map((c) => c.provider);
  const decided: Pick<RequestOutcome, 'features' | 'inputBound' | 'boundAssumed' | 'route' | 'guardrailHits' | 'candidate'> = {
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
      sendError(req, res, own(400, 'invalid_request_error', 'redaction-failed', 'a redacted value could not be replaced without breaking the JSON body; it was not sent'));
      return early({ ...decided, status: 400, decision: { action: 'block', reason: 'redaction-failed' }, errorClass: 'invalid_request_error' });
    }
    upstreamBody = redacted;
  }
  if (plan.preBlock === null && first?.rewritesModel) {
    const rewritten = rewriteTopLevelModel(upstreamBody, first.upstreamModel);
    if (!rewritten) {
      const msg = `route "${plan.route ?? ''}" rewrites the model, but the request's top-level model field could not be located exactly (send one JSON object with a single string "model")`;
      sendError(req, res, own(400, 'invalid_request_error', 'model-rewrite-failed', msg));
      return early({ ...decided, status: 400, decision: { action: 'block', reason: 'model-rewrite-failed' }, errorClass: 'invalid_request_error' });
    }
    upstreamBody = rewritten;
  }
  // reserveOutputTokens: the reservation counts only this many output tokens, so the body must ask for no more (A1).
  if (plan.preBlock === null && plan.outputCap !== undefined) {
    const field = surface === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
    const capped = capTopLevelInteger(upstreamBody, field, plan.outputCap);
    if (!capped) {
      const msg = `route "${plan.route ?? ''}" caps ${field} at ${plan.outputCap}, but the request's top-level ${field} could not be set exactly (send one JSON object with at most one numeric "${field}")`;
      sendError(req, res, own(400, 'invalid_request_error', 'output-cap-failed', msg, null, { shouldRetry: false }));
      return early({ ...decided, status: 400, decision: { action: 'block', reason: 'output-cap-failed' }, errorClass: 'invalid_request_error' });
    }
    upstreamBody = capped;
  }
  // A2-1: the bytes bound counts the bytes sent upstream, not the client's: a redaction placeholder can be longer than
  // the value it replaces (an email becomes a placeholder about three times its length), and a model rewrite or the
  // output cap change the length too. decide runs again on the final length (pure, so the route, chain and cap are the
  // same; only the bound and the reservation follow the bytes), before admit. The trace records this bound, so replay
  // reproduces the reservation, and R11 only ever compares billed input with the bytes actually sent.
  if (plan.preBlock === null && upstreamBody.length !== body.length) {
    try {
      f = featuresFor({ ...features, bodyBytes: upstreamBody.length });
      plan = decide(policy, f);
    } catch {
      sendError(req, res, own(500, 'api_error', 'reservation-error', 'the reservation for this request could not be computed; it was not sent'));
      return early({ ...decided, status: 500, decision: { action: 'block', reason: 'reservation-error' }, errorClass: 'reservation_error' });
    }
    held.plan = plan;
    held.features = f;
    decided.inputBound = { tokens: f.inputTokensBound, kind: f.boundKind };
    if (cp) decided.candidate = auditCandidate(cp, f);
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
      deps.metrics?.inc('tokenyard_store_down_total', { op: 'admit' });
    }
  }
  held.admitted = isAdmitted(plan, admission);
  held.est = held.admitted ? (plan.reservations[0]?.estMicroUsd ?? 0) : 0;
  if (held.admitted) deps.metrics?.inc('tokenyard_reservations_open', {}, 1);
  // A11: the write-ahead line is on disk before anything is sent, so a crash cannot hide this request's spend from the
  // next warm-up; a sink that cannot write it refuses the request (nothing sent, settled at 0).
  let writeAheadFailed = false;
  if (held.admitted && held.est > 0 && deps.traces?.reserved) {
    const line = { id, ts: new Date(startedAt).toISOString(), tenant: f.tenant, team: f.team, keyId: f.keyId, billing: f.billing, attribution: { repo: f.attribution.repo, session: f.attribution.session }, reservedMicroUsd: held.est };
    try {
      writeAheadFailed = !(await withDeadline(deps.traces.reserved(line), WRITE_AHEAD_TIMEOUT_MS));
    } catch {
      writeAheadFailed = true;
    }
  }
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

  if (writeAheadFailed) {
    sendError(req, res, own(503, 'api_error', 'write-ahead-failed', 'the trace line that records this reservation could not be written; it was not sent', 5));
    return early({ ...decided, ...admitted, status: 503, decision: { action: 'block', reason: 'write-ahead-failed' }, errorClass: 'api_error' });
  }

  // 8. Resolve.
  const decision = admission === null ? pre : resolve(policy, plan, admission);
  const provider = first === undefined ? undefined : policy.providers.get(first.provider);
  if (decision.block || !provider) {
    const b = decision.block ?? { status: 403 as const, type: 'permission_error', reason: 'no-route' as const, message: 'no provider serves this route', retryAfterS: null };
    sendError(req, res, own(b.status, b.type, b.reason, b.message, b.retryAfterS, retryable(b.reason) ? {} : { shouldRetry: false }));
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
  const attemptLog: AttemptInfo[] = [];
  const forwardedAt = deps.clock();
  try {
    const r = await runChain(plan, policy, { method, pathAndQuery: match.pathAndQuery, headers: headersFor(provider), body: upstreamBody }, ac.signal, {
      ...failure,
      tenant: key.tenant,
      clock: deps.clock,
      headersFor,
      onAttempt: (a) => attemptLog.push(a),
    });
    up = r.response;
    attempts = r.attempt;
    answered = policy.providers.get(r.provider) ?? provider;
  } catch (err) {
    // A connect-phase failure wrote nothing upstream, so nothing was billed: the reservation settles at 0. Once the body
    // was written the provider may be generating (and billing): settled at the reservation (A6).
    const n = err instanceof ChainError ? err.attempts : 1;
    if (!(err instanceof ChainError) || err.bodySent) held.chargeReservation = true;
    const common = { ...decided, ...admitted, provider: err instanceof ChainError && err.provider ? err.provider : provider.name, attempts: n, attemptLog };
    if (deadlineHit) return deadlineExit(common);
    if (ac.signal.aborted) return early({ ...common, status: 499, aborted: true, errorClass: 'client_abort' });
    sendError(req, res, own(502, 'api_error', 'upstream-unreachable', `upstream ${common.provider} is unreachable`));
    return early({ ...common, status: 502, errorClass: 'upstream_unreachable' });
  }
  const answer = { provider: answered.name, attempts, cacheColdRisk: workspaceOf(answered) !== workspaceOf(provider), attemptLog };
  if (ac.signal.aborted) {
    // The provider answered, so it may have billed; no usage will be read: settled at the reservation (A6).
    held.chargeReservation = true;
    up.body.on('error', () => undefined);
    up.body.destroy();
    if (deadlineHit) return deadlineExit({ ...decided, ...admitted, ...answer });
    return early({ ...decided, ...admitted, ...answer, status: 499, aborted: true, errorClass: 'client_abort' });
  }

  // 10. First response headers: written and flushed at once, never compressed.
  const upstreamHeadersAt = deps.clock();
  const ttfbMs = upstreamHeadersAt - startedAt;
  const outHeaders = clientHeaders(
    up.headers,
    { 'x-tokenyard-request-id': id, 'x-tokenyard-policy-revision': policy.revision, 'X-Accel-Buffering': 'no' },
    answered.credential === 'passthrough' ? 'passthrough' : 'api',
  );
  const clientBody = await withoutCredentialEcho(up, answered, deps.env ?? process.env, outHeaders, held.envelope);
  res.writeHead(up.status, outHeaders);
  res.flushHeaders();

  // 11. Body: every chunk goes on unchanged before it is parsed (an API-mode error body aside); backpressure through pipeline.
  const tap = usageTap(surface, up, deps.bodyCapBytes);
  try {
    await pipeline(clientBody, createTee(tap.onChunk), res);
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
    ...(deadlineHit ? { errorClass: 'request_deadline' } : {}),
  });
}

export function createHandler(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  if ((deps.traces || deps.spans) && !deps.traceSalt) throw new Error('traces and spans need a traceSalt: session and agent ids are HMAC pseudonyms (spec 9.1)');
  if (!deps.guardrailSalt) deps = { ...deps, guardrailSalt: deps.traceSalt ? guardrailKey(deps.traceSalt) : randomBytes(16).toString('hex') };
  const runtime = deps.runtime ?? createGatewayRuntime();
  const admitTimeoutMs = deps.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS;
  // Breaker and retry budget outlive requests; they are rebuilt only when a reload changes the `failure` settings.
  let state: { settings: string; failure: FailureState } | null = null;
  const failureState = (policy: CompiledPolicy): FailureState => {
    const settings = JSON.stringify([policy.failure.breaker, policy.failure.retryBudgetRatio]);
    if (state?.settings !== settings) {
      const onOpen = (scope: 'provider' | 'credential'): void => deps.metrics?.inc('tokenyard_breaker_opens_total', { scope });
      state = { settings, failure: { breaker: new Breaker(policy.failure.breaker, deps.clock, onOpen), retry: new RetryBudget(policy.failure.retryBudgetRatio, deps.clock) } };
    }
    return state.failure;
  };
  return (req, res) => {
    // Health endpoints come first and need no policy: /readyz must answer (503) before one has loaded.
    const ops = matchOps(req.method ?? 'GET', req.url ?? '/', deps.basePath);
    if (ops !== null && ops !== 'metrics') {
      serveOps({ ...deps, admitTimeoutMs }, ops, req, res).catch(() => res.destroy());
      return;
    }
    const id = deps.newId();
    const held: Held = { plan: null, features: null, admitted: false, est: 0, settled: false, chargeReservation: false, envelope: 'anthropic', known: null };
    handle(deps, failureState(deps.policy()), runtime, held, id, req, res).catch(() => {
      // A fault after admit must not hold the reservation and the stream slot until the sweep: settle at the estimate
      // (whether upstream billed is unknown, so fail closed), and queue the trace line with that charge so warm-up
      // (and the live cap across runs) counts it.
      if (held.admitted && !held.settled && deps.store) {
        held.settled = true;
        deps.metrics?.inc('tokenyard_reservations_open', {}, -1);
        const known = held.known;
        const charge = atEstimateCharge(held.plan, held.est);
        const settleSeq = runtime.admits;
        void withDeadline(deps.store.settle(id, charge), admitTimeoutMs)
          .then((r) => r === 'settled', () => false)
          .then((settled) => {
            if (known === null || !(deps.traces || deps.metrics || deps.spans)) return;
            const swept = runtime.takeSwept(id) || !settled;
            let now = known.startedAt;
            try {
              now = deps.clock();
            } catch {
              // the clock is what failed; the line still goes out
            }
            const current = deps.policy();
            const rec = buildTraceRecord(
              {
                ...known,
                status: 500,
                usage: null,
                aborted: false,
                ttfbMs: null,
                totalMs: Math.max(0, now - known.startedAt),
                costMicroUsd: charge,
                addedTtfbMs: null,
                errorClass: 'internal_error',
                settledAtEstimate: true,
                settledBy: swept ? 'sweeper' : 'request',
                settleSeq,
                seqEpoch: runtime.epoch,
                chargedMicroUsd: swept ? held.est : charge,
                overrun: charge > held.est,
              },
              deps.traceSalt ?? '',
              current,
            );
            emitTelemetry(deps, current, rec);
            deps.traces?.write(rec);
          })
          .catch(() => undefined);
      }
      try {
        if (!res.headersSent) sendError(req, res, ownError(held.envelope, 500, 'api_error', 'internal_error', 'internal error', null, id));
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  };
}
