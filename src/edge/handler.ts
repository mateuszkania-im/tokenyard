import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { TraceRecord } from '../ledger/record.js';
import type { CounterStore } from '../limits/store.js';
import type { CompiledPolicy, KeyRecord, ProviderSpec, Surface } from '../policy/types.js';
import { costMicroUsd } from '../pricing/cost.js';
import type { PriceTable } from '../pricing/prices.js';
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

/** Where finished request records go. Implemented by TraceWriter (Task 7); `null` until then. */
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
  /** Price table for actual cost; without it no cost is computed. Task 10 takes it from the compiled policy. */
  prices?: PriceTable | null;
  /** `serve --experimental-subscription` (spec 6.8): without it keys with `billing: subscription` get 401. */
  experimentalSubscription?: boolean;
  /** Called after the response has ended with what the request knew; the trace writer (Task 7) and settlement (Task 14) replace it. */
  onSettled?: (outcome: RequestOutcome) => void;
}

/** What the end of a request knows; settlement (Task 14) and the trace (Task 7) are built from it. */
export interface RequestOutcome {
  id: string;
  key: KeyRecord;
  attribution: RawAttribution;
  surface: Surface;
  features: ExtractedFeatures;
  provider: string;
  status: number;
  usage: UsageResult | null;
  aborted: boolean;
  startedAt: number;
  ttfbMs: number;
  totalMs: number;
  /** Actual cost from the final or partial usage; null when there is no usage or the model is unpriced. */
  costMicroUsd: number | null;
  /** `api-equivalent` for subscription keys (spec 7.6), else `billed`. */
  costBasis: 'billed' | 'api-equivalent';
}

type ErrorReply = ReturnType<typeof anthropicError>;

function sendError(req: IncomingMessage, res: ServerResponse, e: ErrorReply, closeConnection = false): void {
  // An early answer leaves an unread upload behind; drain it (or close the connection) so the socket is not stuck.
  req.resume();
  res.writeHead(e.status, closeConnection ? { ...e.headers, connection: 'close' } : e.headers).end(e.body);
}

/**
 * Spec 5.3 steps 5 to 8 placeholder until Tasks 10 and 14 (guardrails, decide, admit, resolve):
 * the first route serving this surface, forwarded to the first provider of its chain.
 */
function forwardToFirstProvider(policy: CompiledPolicy, surface: Surface): ProviderSpec | null {
  const route = policy.routes.find((r) => r.surfaces.includes(surface));
  const name = route?.chain[0];
  return name === undefined ? null : (policy.providers.get(name) ?? null);
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

function priceOutcome(deps: GatewayDeps, features: ExtractedFeatures, usage: UsageResult | null): number | null {
  const model = usage?.responseModel ?? features.model;
  if (!deps.prices || !usage?.usage || !model) return null;
  try {
    return costMicroUsd(deps.prices, model, usage.usage);
  } catch {
    return null; // unpriced model: Task 10's `unpricedModel` policy decides what that means
  }
}

/** Settlement (Task 14) and the trace record (Task 7) hook in here, after `res.end()`. */
function afterResponse(deps: GatewayDeps, outcome: RequestOutcome): void {
  deps.onSettled?.(outcome);
}

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
    const body = modelsListBody(policy.routes.flatMap((r) => r.models));
    res
      .writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length), 'x-tokenyard-request-id': id })
      .end(body);
    return;
  }
  const surface = match.surface;

  // 3. Read the body.
  let body: Buffer;
  try {
    body = await readBody(req, deps.bodyCapBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      const msg = `request body is larger than the ${err.capBytes} byte limit`;
      sendError(req, res, anthropicError(413, 'request_too_large', msg, null, id), true);
    }
    return; // otherwise the client went away mid-upload
  }

  // 4. Extract features (read-only; the body Buffer is forwarded as received).
  const features = extractFeatures(surface, body);

  // 5 to 8. Guardrails, decide, admit, resolve: placeholder until Tasks 10 and 14.
  const provider = forwardToFirstProvider(policy, surface);
  if (!provider) {
    return sendError(req, res, anthropicError(403, 'permission_error', 'no route allows this request', null, id));
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
  try {
    up = await forward(provider, { method, pathAndQuery: match.pathAndQuery, headers, body }, ac.signal);
  } catch {
    if (ac.signal.aborted) return;
    return sendError(req, res, anthropicError(502, 'api_error', `upstream ${provider.name} is unreachable`, null, id));
  }
  if (ac.signal.aborted) {
    up.body.on('error', () => undefined);
    up.body.destroy();
    return;
  }

  // 10. First response headers: written and flushed at once, never compressed.
  const ttfbMs = deps.clock() - startedAt;
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
    features,
    provider: provider.name,
    status: up.status,
    usage,
    aborted: ac.signal.aborted,
    startedAt,
    ttfbMs,
    totalMs: deps.clock() - startedAt,
    costMicroUsd: priceOutcome(deps, features, usage),
    costBasis: key.billing === 'subscription' ? 'api-equivalent' : 'billed',
  });
}

export function createHandler(deps: GatewayDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const id = deps.newId();
    handle(deps, id, req, res).catch(() => {
      if (!res.headersSent) sendError(req, res, anthropicError(500, 'api_error', 'internal error', null, id));
      else res.destroy();
    });
  };
}
