// A mock OpenAI Responses provider for tests and the demo (spec 10): it records exactly what it received and answers
// `POST /responses` (and `/v1/responses`) with scripted, deterministic bodies in the documented streaming shape.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockServer } from './anthropic.js';
import { DEFAULT_SCENARIO, type ReceivedRequest, record, type Scenario } from './scenarios.js';

/** The shared scenarios, plus the two Responses terminal events that are not `response.completed`. */
export type OpenAIScenario = Scenario | { kind: 'failed'; afterEvents: number; code: string } | { kind: 'incomplete'; reason: string };

export interface OpenAIMockServer extends Omit<MockServer, 'setScenario'> {
  setScenario(s: OpenAIScenario | ((r: ReceivedRequest) => OpenAIScenario)): void;
}

export interface OpenAIMockOptions {
  port?: number;
  /** Address to bind (default 127.0.0.1; the compose demo binds 0.0.0.0 inside its container). */
  host?: string;
  scenario?: OpenAIScenario;
  /** Most requests kept in `received`, newest last (default all; `tokenyard mock` keeps none). */
  keepReceived?: number;
  /** Most prompt cache keys remembered, least recently used dropped first (default 10,000). */
  maxCacheKeys?: number;
}

type Obj = Record<string, unknown>;
const MAX_DELTAS = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseBody(body: Buffer): Obj {
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
  } catch {
    return {};
  }
}

function splitTokens(output: number): number[] {
  const n = Math.min(output, MAX_DELTAS);
  if (n === 0) return [];
  const base = Math.floor(output / n);
  const extra = output % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

interface MockUsage {
  input: number;
  cached: number;
  output: number;
}

const usageJson = (u: MockUsage): Obj => ({
  input_tokens: u.input,
  input_tokens_details: { cached_tokens: u.cached },
  output_tokens: u.output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: u.input + u.output,
});

const frame = (data: Obj): string => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;

export async function startOpenAIMock(opts: OpenAIMockOptions = {}): Promise<OpenAIMockServer> {
  const received: ReceivedRequest[] = [];
  let scenario: OpenAIScenario | ((r: ReceivedRequest) => OpenAIScenario) = opts.scenario ?? DEFAULT_SCENARIO;
  let respCount = 0;
  /** Prompt cache by `prompt_cache_key`: the bytes of the previous request count as cached when the prefix repeats. */
  const cache = new Map<string, number>();
  const maxCacheKeys = opts.maxCacheKeys ?? 10_000;

  async function respond(rec: ReceivedRequest, res: ServerResponse): Promise<void> {
    const path = rec.pathAndQuery.split('?')[0];
    if (rec.method !== 'POST' || (path !== '/responses' && path !== '/v1/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found","type":"invalid_request_error","param":null,"code":"unknown_url"}}');
      return;
    }
    const sc = typeof scenario === 'function' ? scenario(rec) : scenario;
    if (sc.kind === 'hangBeforeHeaders') return;
    if (sc.kind === 'status') {
      res.writeHead(sc.status, { 'content-type': 'application/json', ...sc.headers }).end(sc.body);
      return;
    }
    const body = parseBody(rec.body);
    const model = typeof body.model === 'string' ? body.model : 'gpt-mock';
    const outputTokens = sc.kind === 'ok' ? sc.outputTokens : DEFAULT_SCENARIO.kind === 'ok' ? DEFAULT_SCENARIO.outputTokens : 16;
    const input = Math.ceil(rec.body.length / 4);
    const key = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : null;
    const prev = key === null ? 0 : (cache.get(key) ?? 0);
    if (key !== null) {
      // Least recently used first: a key is moved to the end on every use and the oldest goes past the cap (V2).
      cache.delete(key);
      cache.set(key, rec.body.length);
      for (const old of cache.keys()) {
        if (cache.size <= maxCacheKeys) break;
        cache.delete(old);
      }
    }
    const usage: MockUsage = { input, cached: Math.min(input, Math.floor(Math.min(prev, rec.body.length) / 4 / 128) * 128), output: outputTokens };
    const id = `resp_mock_${String(++respCount).padStart(6, '0')}`;
    const text = splitTokens(outputTokens).map((t) => 'x'.repeat(t * 4));
    const status = sc.kind === 'incomplete' ? 'incomplete' : 'completed';
    const response = (st: string, withUsage: boolean): Obj => ({
      id,
      object: 'response',
      created_at: 1_700_000_000,
      status: st,
      model,
      // The tier that served the request: the one asked for, `default` for `auto` or none.
      service_tier: typeof body.service_tier === 'string' && body.service_tier !== 'auto' ? body.service_tier : 'default',
      output: st === 'in_progress' ? [] : [{ type: 'message', id: `msg_${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: text.join(''), annotations: [] }] }],
      ...(sc.kind === 'incomplete' && st === 'incomplete' ? { incomplete_details: { reason: sc.reason } } : {}),
      usage: withUsage ? usageJson(usage) : null,
    });

    if (body.stream !== true) {
      if (sc.kind === 'drop') {
        res.socket?.destroy();
        return;
      }
      if (sc.kind === 'ok' && sc.ttftMs > 0) await sleep(sc.ttftMs);
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': id }).end(JSON.stringify(response(status, true)));
      return;
    }

    let seq = 0;
    const ev = (type: string, rest: Obj): Obj => ({ type, sequence_number: seq++, ...rest });
    const events: Obj[] = [
      ev('response.created', { response: response('in_progress', false) }),
      ev('response.in_progress', { response: response('in_progress', false) }),
      ev('response.output_item.added', { output_index: 0, item: { type: 'message', id: `msg_${id}`, status: 'in_progress', role: 'assistant', content: [] } }),
      ...text.map((delta) => ev('response.output_text.delta', { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta })),
      ev('response.output_text.done', { item_id: `msg_${id}`, output_index: 0, content_index: 0, text: text.join('') }),
    ];
    if (sc.kind === 'incomplete') events.push(ev('response.incomplete', { response: response('incomplete', true) }));
    else events.push(ev('response.completed', { response: response('completed', true) }));

    let closed = false;
    res.on('close', () => (closed = true));
    const write = (chunk: string): Promise<void> =>
      new Promise((resolve) => {
        if (closed || res.destroyed) return resolve();
        res.write(chunk, () => resolve());
      });
    if (sc.kind === 'ok' && sc.ttftMs > 0) await sleep(sc.ttftMs);
    if (closed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-request-id': id });
    for (let i = 0; i < events.length; i++) {
      if (sc.kind === 'drop' && i === sc.afterEvents) {
        res.socket?.destroy();
        return;
      }
      if ((sc.kind === 'failed' || sc.kind === 'midStreamError') && i === sc.afterEvents) {
        const code = sc.kind === 'failed' ? sc.code : sc.errorType;
        await write(frame(ev('response.failed', { response: { ...response('failed', false), error: { code, message: 'mock failure' } } })));
        break;
      }
      if (closed) return;
      await write(frame(events[i] as Obj));
      if (sc.kind === 'pauseAfterStart' && i === 0) await sleep(sc.pauseMs);
    }
    if (!closed) res.end();
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
      const rec: ReceivedRequest = { method: req.method ?? 'GET', pathAndQuery: req.url ?? '/', headers, body: Buffer.concat(chunks) };
      record(received, rec, opts.keepReceived);
      respond(rec, res).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    setScenario(s) {
      scenario = s;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
