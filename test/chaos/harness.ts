// Chaos harness (V3): the real gateway on loopback in front of scripted upstreams, with a client that can misbehave.
// Every scenario ends with `checkInvariants`: no reservation or stream slot left in the store, exactly one trace line per
// request with a charge that matches its settlement, every request charged at least what the upstream billed, fallback
// only before the first byte, no unhandled rejection, and the gateway still serving. Mock upstreams only.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { createGatewayRuntime, type GatewayRuntime, type RequestOutcome } from '../../src/edge/handler.js';
import { pseudonym } from '../../src/guardrails/hmac.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore, type MemoryCounterStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { PolicyDoc } from '../../src/policy/schema.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';

export const MODEL = 'claude-haiku-5-5';
export const SALT = 'chaos-salt';
const RETRYABLE = new Set([500, 502, 503, 504, 529]);

// ---- unhandled rejections -------------------------------------------------------------------------------------------
const rejections: unknown[] = [];
process.on('unhandledRejection', (e) => rejections.push(e));
export const unhandledRejections = (): unknown[] => rejections;

// ---- scripted upstream ---------------------------------------------------------------------------------------------

/** What one upstream attempt does with a request it received in full. */
export type Behaviour =
  | { kind: 'ok'; stream?: boolean; outputTokens?: number; ttfbMs?: number; chunkDelayMs?: number; padEvents?: number; padBytes?: number; cutAt?: number; cutAfterHeaders?: boolean }
  | { kind: 'status'; status: number }
  | { kind: 'hang' }
  | { kind: 'reset' };

export interface UpstreamAttempt {
  chaosId: string;
  provider: string;
  /** 1-based attempt number of this chaos id across both upstreams. */
  n: number;
  behaviour: Behaviour['kind'];
  status: number | null;
  /** Micro-USD the provider would bill: the whole generation once it started answering 200, else 0. */
  billedMicroUsd: number;
  bytesWritten: number;
  /** The gateway closed the connection before the attempt finished writing. */
  closedEarly: boolean;
  /** Writes waiting for 'drain' so far: the gateway pushed back (backpressure reached the upstream). */
  drainWaits: number;
  /** Waiting for 'drain' right now. */
  waitingDrain: boolean;
}

export interface ChaosUpstream {
  url: string;
  name: string;
  server: Server;
  close(): Promise<void>;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Resolves on 'drain' or 'close', whichever comes first, and removes both listeners. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((r) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      r();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** The events of `sseMessage`, generated one at a time. */
export function* sseEvents(o: { input: number; output: number; padEvents?: number; padBytes?: number }): Generator<string> {
  const all = sseMessage({ ...o, padEvents: 1 });
  const [start, blockStart, pad, ...tail] = all as [string, string, string, ...string[]];
  yield start;
  yield blockStart;
  for (let i = 0; i < (o.padEvents ?? 8); i++) yield pad;
  yield* tail;
}

/** SSE bytes of one Anthropic message with `outputTokens` output, `pad` ping events of `padBytes` each before the end. */
export function sseMessage(o: { input: number; output: number; padEvents?: number; padBytes?: number }): string[] {
  const usage = { input_tokens: o.input, output_tokens: o.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const pad = 'p'.repeat(o.padBytes ?? 64);
  return [
    sse('message_start', { type: 'message_start', message: { id: 'msg_chaos', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...Array.from({ length: o.padEvents ?? 8 }, () => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: pad } })),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
    sse('message_stop', { type: 'message_stop' }),
  ];
}

export interface Harness {
  gw: TestGateway;
  url: string;
  policy: CompiledPolicy;
  store: CounterStore;
  memory: MemoryCounterStore | null;
  runtime: GatewayRuntime;
  outcomes: RequestOutcome[];
  records: Array<Omit<TraceRecord, 'instance' | 'seq'>>;
  /** Request ids the gateway handed out: one per request that reached its handler. */
  ids: string[];
  attempts: UpstreamAttempt[];
  primary: ChaosUpstream;
  backup: ChaosUpstream;
  /** Sets what the upstreams do; `n` counts attempts of the chaos id across both upstreams. */
  setBehaviour(fn: (a: { chaosId: string; provider: string; n: number }) => Behaviour): void;
  close(): Promise<void>;
}

const usageOf = (bodyBytes: number, output: number): { input: number; output: number } => ({ input: Math.max(1, Math.floor(bodyBytes / 8)), output });

function startUpstream(name: string, h: { onRequest(provider: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void }): Promise<ChaosUpstream> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => h.onRequest(name, req, res, Buffer.concat(chunks)));
    req.on('error', () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        name,
        server,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      }),
    ),
  );
}

/** The chaos id a request body carries (`messages[0].content` is `chaos:<id>`). */
function chaosIdOf(body: Buffer): string {
  const m = /chaos:([A-Za-z0-9_-]+)/.exec(body.toString('latin1', 0, Math.min(body.length, 4096)));
  return m?.[1] ?? 'unknown';
}

export async function startHarness(o: {
  edit?: (p: PolicyDoc) => void;
  /** Replace the backup provider's URL (connection refused, DNS failure). */
  backupUrl?: string;
  primaryUrl?: string;
  store?: CounterStore;
  deadlineMs?: number;
  requestDeadlineMs?: number;
  admitTimeoutMs?: number;
  runtime?: GatewayRuntime;
  gateway?: Partial<Parameters<typeof startGateway>[0]>;
} = {}): Promise<Harness> {
  const attempts: UpstreamAttempt[] = [];
  const perId = new Map<string, number>();
  let behaviour: (a: { chaosId: string; provider: string; n: number }) => Behaviour = () => ({ kind: 'ok' });
  let policy: CompiledPolicy | null = null;

  const onRequest = (provider: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void => {
    const chaosId = chaosIdOf(body);
    const n = (perId.get(chaosId) ?? 0) + 1;
    perId.set(chaosId, n);
    const b = behaviour({ chaosId, provider, n });
    const a: UpstreamAttempt = { chaosId, provider, n, behaviour: b.kind, status: null, billedMicroUsd: 0, bytesWritten: 0, closedEarly: false, drainWaits: 0, waitingDrain: false };
    attempts.push(a);
    let finished = false;
    res.on('close', () => {
      if (!finished) a.closedEarly = true;
    });
    if (b.kind === 'hang') return;
    if (b.kind === 'reset') {
      req.socket.destroy();
      return;
    }
    if (b.kind === 'status') {
      a.status = b.status;
      const text = JSON.stringify({ type: 'error', error: { type: b.status === 529 ? 'overloaded_error' : 'api_error', message: 'chaos' } });
      res.writeHead(b.status, { 'content-type': 'application/json', 'x-chaos-attempt': String(n) }).end(text, () => (finished = true));
      a.bytesWritten = text.length;
      return;
    }
    const json = JSON.parse(body.toString('utf8')) as { stream?: boolean; max_tokens?: number };
    const u = usageOf(body.length, Math.min(b.outputTokens ?? 40, json.max_tokens ?? 64));
    a.billedMicroUsd = costMicroUsd((policy as CompiledPolicy).prices, MODEL, { input: u.input, output: u.output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    const run = async (): Promise<void> => {
      if (b.ttfbMs) await new Promise((r) => setTimeout(r, b.ttfbMs));
      if (res.destroyed) return;
      a.status = 200;
      if (json.stream !== true) {
        const text = JSON.stringify({ id: 'msg_chaos', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: u.input, output_tokens: u.output } });
        res.writeHead(200, { 'content-type': 'application/json', 'x-chaos-attempt': String(n) });
        if (b.cutAfterHeaders) {
          res.flushHeaders();
          setTimeout(() => req.socket.destroy(), 5);
          return;
        }
        const cut = b.cutAt;
        if (cut !== undefined && cut < text.length) {
          res.write(text.slice(0, cut));
          a.bytesWritten = cut;
          setTimeout(() => req.socket.destroy(), 5);
          return;
        }
        a.bytesWritten = text.length;
        res.end(text, () => (finished = true));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-chaos-attempt': String(n) });
      res.flushHeaders();
      if (b.cutAfterHeaders) {
        setTimeout(() => req.socket.destroy(), 5);
        return;
      }
      // Written event by event (a 64 MiB answer is never held whole); `cutAt` counts bytes across events.
      const events = sseEvents({ ...u, padEvents: b.padEvents ?? 8, padBytes: b.padBytes ?? 64 });
      const stop = b.cutAt ?? Number.POSITIVE_INFINITY;
      for (const ev of events) {
        if (res.destroyed) return;
        const piece = a.bytesWritten + ev.length > stop ? ev.slice(0, stop - a.bytesWritten) : ev;
        a.bytesWritten += piece.length;
        if (piece.length > 0 && !res.write(piece)) {
          a.drainWaits++;
          a.waitingDrain = true;
          await drained(res);
          a.waitingDrain = false;
        }
        if (a.bytesWritten >= stop) {
          setTimeout(() => req.socket.destroy(), 5);
          return;
        }
        if (b.chunkDelayMs) await new Promise((r) => setTimeout(r, b.chunkDelayMs));
      }
      res.end(() => (finished = true));
    };
    run().catch(() => res.destroy());
  };

  const primary = await startUpstream('anthropic', { onRequest });
  const backup = await startUpstream('anthropic-backup', { onRequest });
  process.env[PROVIDER_KEY_ENV] = 'sk-chaos-provider';
  policy = testPolicy({
    upstream: o.primaryUrl ?? primary.url,
    models: [MODEL],
    edit: (p) => {
      (p.providers['anthropic-backup'] as { baseUrl: string }).baseUrl = o.backupUrl ?? backup.url;
      // Chaos sends a few hundred requests in seconds: rate and stream limits far above that, budgets as in the example.
      p.rateLimits = [
        { name: 'dev-rpm', scope: 'key', rpm: 1_000_000, burst: 100_000 },
        { name: 'dev-streams', scope: 'key', concurrentStreams: 10_000 },
      ] as PolicyDoc['rateLimits'];
      // Every failed attempt may fall back (the retry budget has its own case with the example's 10%).
      p.failure = { ...p.failure, retryBudgetRatio: 1 };
      o.edit?.(p);
    },
  });
  const runtime = o.runtime ?? createGatewayRuntime();
  const memory = o.store ? null : createMemoryStore({ clock: Date.now, deadlineMs: o.deadlineMs ?? 600_000, onSwept: (ids) => runtime.onSwept(ids) });
  const store = o.store ?? (memory as MemoryCounterStore);
  const outcomes: RequestOutcome[] = [];
  const records: Harness['records'] = [];
  const ids: string[] = [];
  const gw = await startGateway({
    onId: (id) => ids.push(id),
    policy: policy,
    store,
    runtime,
    clock: () => Date.now(),
    traceSalt: SALT,
    traces: { write: (r) => (records.push(r), true) },
    onSettled: (x) => outcomes.push(x),
    ...(o.requestDeadlineMs !== undefined ? { requestDeadlineMs: o.requestDeadlineMs } : {}),
    ...(o.admitTimeoutMs !== undefined ? { admitTimeoutMs: o.admitTimeoutMs } : {}),
    ...o.gateway,
  });
  return {
    gw,
    url: gw.url,
    policy,
    store,
    memory,
    runtime,
    outcomes,
    records,
    ids,
    attempts,
    primary,
    backup,
    setBehaviour(fn) {
      behaviour = fn;
    },
    async close() {
      await gw.close();
      await primary.close();
      await backup.close();
      delete process.env[PROVIDER_KEY_ENV];
    },
  };
}

// ---- misbehaving client ---------------------------------------------------------------------------------------------

export type ClientMode =
  | { kind: 'normal' }
  | { kind: 'abortBeforeBody' }
  | { kind: 'abortMidUpload' }
  | { kind: 'abortAfterHeaders' }
  | { kind: 'abortAfterBytes'; bytes: number }
  | { kind: 'abortAfterMs'; ms: number };

export interface ClientResult {
  chaosId: string;
  status: number | null;
  bytes: number;
  /** `x-chaos-attempt` of the response the client got, when the upstream's answer reached it. */
  attempt: number | null;
  error: string | null;
}

export function chatBody(chaosId: string, o: { stream?: boolean; maxTokens?: number; padBytes?: number } = {}): Buffer {
  const text = `chaos:${chaosId} ${'x'.repeat(o.padBytes ?? 0)}`;
  return Buffer.from(JSON.stringify({ model: MODEL, max_tokens: o.maxTokens ?? 64, stream: o.stream ?? true, messages: [{ role: 'user', content: text }] }));
}

export function headersFor(chaosId: string): Record<string, string> {
  return { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': `s-${chaosId}` };
}

/** One request as the client mode says; resolves when the client is done (never rejects). */
export function chaosRequest(base: string, chaosId: string, body: Buffer, mode: ClientMode = { kind: 'normal' }, agent?: import('node:http').Agent): Promise<ClientResult> {
  return new Promise((resolve) => {
    const u = new URL(base);
    const out: ClientResult = { chaosId, status: null, bytes: 0, attempt: null, error: null };
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(out);
    };
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: { ...headersFor(chaosId), 'content-length': String(body.length) }, ...(agent ? { agent } : {}) }, (res) => {
      out.status = res.statusCode ?? 0;
      const att = res.headers['x-chaos-attempt'];
      out.attempt = att === undefined ? null : Number(att);
      if (mode.kind === 'abortAfterHeaders') {
        req.destroy();
        return finish();
      }
      res.on('data', (c: Buffer) => {
        out.bytes += c.length;
        if (mode.kind === 'abortAfterBytes' && out.bytes >= mode.bytes) {
          req.destroy();
          finish();
        }
      });
      res.on('end', finish);
      res.on('error', (e) => ((out.error = e.message), finish()));
      res.on('close', finish);
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      out.error = e.code ?? e.message;
      finish();
    });
    if (mode.kind === 'abortBeforeBody') {
      req.flushHeaders();
      setTimeout(() => (req.destroy(), finish()), 20);
      return;
    }
    if (mode.kind === 'abortMidUpload') {
      req.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => (req.destroy(), finish()), 20);
      return;
    }
    if (mode.kind === 'abortAfterMs') setTimeout(() => (req.destroy(), finish()), mode.ms);
    req.end(body);
  });
}

// ---- invariants ---------------------------------------------------------------------------------------------------

export interface InvariantOptions {
  /** Requests that never reach the gateway's handler with a session (none so far). */
  expectSweeper?: boolean;
  /** Skip the store check (Redis scenarios check their own keys). */
  skipStore?: boolean;
}

const sessionPseudonym = (chaosId: string): string => pseudonym(SALT, `s-${chaosId}`);

/**
 * Waits until every request settled and checks the V3 invariants. `sent` are the client results of the scenario; every
 * one is an authenticated request, so each must have exactly one trace line.
 */
export async function checkInvariants(h: Harness, sent: ClientResult[], o: InvariantOptions = {}): Promise<void> {
  // Every request the gateway received gets exactly one line; a client that left before its request reached the
  // gateway (its connection reset before the headers were read) has none, and nothing else.
  await expect.poll(() => h.records.length, { timeout: 10_000 }).toBe(h.ids.length);
  await new Promise((r) => setTimeout(r, 30)); // a late duplicate would show here
  expect(new Set(h.records.map((r) => r.id)).size).toBe(h.records.length);
  expect(h.records.map((r) => r.id).sort()).toEqual([...h.ids].sort());
  for (const s of sent) {
    const p = sessionPseudonym(s.chaosId);
    const lines = h.records.filter((r) => r.attribution.session === p);
    const ups = h.attempts.filter((a) => a.chaosId === s.chaosId);
    // A request the client got an answer for, or one that reached a provider, was received by the gateway.
    if (s.status !== null || ups.length > 0) expect(lines, `trace lines for ${s.chaosId}`).toHaveLength(1);
    else expect(lines.length, `trace lines for ${s.chaosId}`).toBeLessThanOrEqual(1);
    const r = lines[0];
    if (r === undefined) continue;
    const reserved = r.decision.reservedMicroUsd;
    const billed = ups.reduce((t, a) => t + a.billedMicroUsd, 0);
    if (reserved > 0) {
      expect(r.outcome.chargedMicroUsd, `chargedMicroUsd of ${s.chaosId}`).toBeDefined();
      if (!o.expectSweeper) expect(r.outcome.settledBy, `settledBy of ${s.chaosId}`).toBe('request');
      if (r.outcome.settledBy === 'request') expect(r.outcome.chargedMicroUsd).toBe(r.outcome.costMicroUsd);
      else expect(r.outcome.chargedMicroUsd).toBe(reserved);
      expect(r.outcome.chargedMicroUsd ?? 0, `charged vs billed for ${s.chaosId}`).toBeGreaterThanOrEqual(billed);
    } else {
      // Nothing reserved: refused before admit, so nothing may have reached a provider.
      expect(ups, `upstream attempts of unreserved ${s.chaosId}`).toEqual([]);
    }
    // Fallback only before the first byte: every attempt but the last answered a retryable status in full.
    ups.slice(0, -1).forEach((a) => {
      expect(a.status !== null && RETRYABLE.has(a.status), `attempt ${a.n} of ${s.chaosId} (${a.behaviour}, ${a.status}) was followed by another`).toBe(true);
    });
    if (s.attempt !== null) expect(s.attempt, `client saw attempt ${s.attempt} of ${s.chaosId}`).toBe(ups.at(-1)?.n);
    if (r.outcome.attempts !== undefined) expect(ups.length).toBeLessThanOrEqual(r.outcome.attempts);
  }
  if (!o.skipStore && h.memory) await expectStoreClean(h.memory);
  expect(unhandledRejections()).toEqual([]);
  await expectServing(h);
}

/** No open reservation, deadline set or stream slot, and nothing reserved on any budget key. */
export async function expectStoreClean(m: MemoryCounterStore): Promise<void> {
  const keys = m.keys();
  expect(keys.filter((k) => /:(res|deadlines|st):/.test(k) || k.endsWith(':deadlines'))).toEqual([]);
  const budgets = keys.filter((k) => /:b:/.test(k));
  const snap = await m.snapshot(budgets);
  expect(Object.entries(snap).filter(([, v]) => v.reserved !== 0)).toEqual([]);
}

/** One healthy request still gets a full answer. */
export async function expectServing(h: Harness): Promise<void> {
  const probe = `probe${Math.random().toString(36).slice(2, 10)}`;
  const r = await chaosRequest(h.url, probe, chatBody(probe));
  // The upstream behaviour may still be hostile: the probe only proves the gateway answers.
  expect(r.status, `probe status (${r.error ?? ''})`).not.toBeNull();
}

/** Seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
