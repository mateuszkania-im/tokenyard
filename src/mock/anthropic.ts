import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Usage } from '../stream/anthropic-usage.js';
import { CacheSimulator, countTokens } from './cache-sim.js';
import { DEFAULT_SCENARIO, mulberry32, type ReceivedRequest, type Scenario } from './scenarios.js';

export type { ReceivedRequest, Scenario } from './scenarios.js';

export interface MockServer {
  url: string;
  received: ReceivedRequest[];
  setScenario(s: Scenario | ((r: ReceivedRequest) => Scenario)): void;
  close(): Promise<void>;
}

export interface MockOptions {
  /** Listen port; 0 (default) picks an ephemeral one. */
  port?: number;
  /** Address to bind (default 127.0.0.1; the compose demo binds 0.0.0.0 inside its container). */
  host?: string;
  workspace?: string;
  scenario?: Scenario;
  /** Clock for the cache simulator; defaults to Date.now. */
  now?: () => number;
}

type Obj = Record<string, unknown>;
interface ScriptedEvent {
  event: string;
  data: Obj;
}

const MAX_DELTAS = 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function usageJson(u: Usage): Obj {
  return {
    input_tokens: u.input,
    cache_creation_input_tokens: u.cacheWrite5m + u.cacheWrite1h,
    cache_read_input_tokens: u.cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite5m, ephemeral_1h_input_tokens: u.cacheWrite1h },
    output_tokens: u.output,
  };
}

function splitTokens(output: number): number[] {
  const n = Math.min(output, MAX_DELTAS);
  if (n === 0) return [];
  const base = Math.floor(output / n);
  const extra = output % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

function scriptedEvents(id: string, model: string, usage: Usage): { head: ScriptedEvent[]; deltas: ScriptedEvent[]; tail: ScriptedEvent[] } {
  const head: ScriptedEvent[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usageJson(usage), output_tokens: 1 } },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  ];
  const deltas = splitTokens(usage.output).map((t) => ({
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(t * 4) } },
  }));
  const tail: ScriptedEvent[] = [
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usageJson(usage) } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  return { head, deltas, tail };
}

const frame = (e: ScriptedEvent): string => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;

function parseBody(body: Buffer): Obj {
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
  } catch {
    return {};
  }
}

export async function startAnthropicMock(opts: MockOptions = {}): Promise<MockServer> {
  const received: ReceivedRequest[] = [];
  const now = opts.now ?? Date.now;
  const sims = new Map<string, CacheSimulator>();
  let scenario: Scenario | ((r: ReceivedRequest) => Scenario) = opts.scenario ?? DEFAULT_SCENARIO;
  let requestCount = 0;
  let msgCount = 0;

  const simFor = (req: ReceivedRequest): CacheSimulator => {
    const h = req.headers['x-mock-workspace'];
    const ws = (Array.isArray(h) ? h[0] : h) ?? opts.workspace ?? 'default';
    let s = sims.get(ws);
    if (!s) sims.set(ws, (s = new CacheSimulator(ws)));
    return s;
  };

  async function respond(rec: ReceivedRequest, res: ServerResponse): Promise<void> {
    const path = rec.pathAndQuery.split('?')[0];
    const body = parseBody(rec.body);
    const sc = typeof scenario === 'function' ? scenario(rec) : scenario;
    if (rec.method !== 'POST' || (path !== '/v1/messages' && path !== '/v1/messages/count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
      return;
    }
    if (path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: countTokens(body) }));
      return;
    }
    if (sc.kind === 'hangBeforeHeaders') return;
    if (sc.kind === 'status') {
      res.writeHead(sc.status, { 'content-type': 'application/json', ...sc.headers }).end(sc.body);
      return;
    }

    const model = typeof body.model === 'string' ? body.model : 'claude-mock';
    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 1024;
    const usage = simFor(rec).usageFor(body, model, now());
    const timing = { ttftMs: 0, tokensPerSec: 0, pingEveryMs: null as number | null };
    let outputTokens = DEFAULT_SCENARIO.kind === 'ok' ? DEFAULT_SCENARIO.outputTokens : 16;
    if (sc.kind === 'ok') {
      timing.ttftMs = sc.ttftMs;
      timing.tokensPerSec = sc.tokensPerSec;
      timing.pingEveryMs = sc.pingEveryMs;
      outputTokens = sc.outputTokens;
    } else if (sc.kind === 'randomUsage') {
      const rng = mulberry32(sc.seed + requestCount);
      const bytes = rec.body.length;
      const totalIn = Math.floor(rng() * (bytes + 1));
      const cuts = [rng(), rng(), rng()].sort((a, b) => a - b).map((c) => Math.floor(c * (totalIn + 1)));
      usage.input = cuts[0] as number;
      usage.cacheRead = (cuts[1] as number) - (cuts[0] as number);
      usage.cacheWrite5m = (cuts[2] as number) - (cuts[1] as number);
      usage.cacheWrite1h = totalIn - (cuts[2] as number);
      outputTokens = Math.floor(rng() * (maxTokens + 1));
    }
    usage.output = outputTokens;
    const id = `msg_mock_${String(++msgCount).padStart(6, '0')}`;

    if (body.stream !== true) {
      if (sc.kind === 'drop') {
        res.socket?.destroy();
        return;
      }
      if (sc.kind === 'midStreamError') {
        res.writeHead(529, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: sc.errorType, message: 'mock error' } }));
        return;
      }
      if (timing.ttftMs > 0) await sleep(timing.ttftMs);
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': id });
      res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'x'.repeat(outputTokens * 4) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: usageJson(usage),
        }),
      );
      return;
    }

    let closed = false;
    res.on('close', () => (closed = true));
    const write = (chunk: string): Promise<void> =>
      new Promise((resolve) => {
        if (closed || res.destroyed) return resolve();
        res.write(chunk, () => resolve());
      });
    const { head, deltas, tail } = scriptedEvents(id, model, usage);
    const all = [...head, ...deltas, ...tail];
    if (timing.ttftMs > 0) await sleep(timing.ttftMs);
    if (closed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': id });
    let pinger: NodeJS.Timeout | undefined;
    const stopPings = (): void => {
      if (pinger) clearInterval(pinger);
    };
    res.on('close', stopPings);
    if (timing.pingEveryMs !== null && timing.pingEveryMs > 0) {
      pinger = setInterval(() => void write('event: ping\ndata: {"type": "ping"}\n\n'), timing.pingEveryMs);
    }
    const perDeltaMs = timing.tokensPerSec > 0 ? (1000 * Math.max(1, outputTokens / Math.max(1, deltas.length))) / timing.tokensPerSec : 0;
    try {
      for (let i = 0; i < all.length; i++) {
        if (sc.kind === 'midStreamError' && i === sc.afterEvents) {
          await write(frame({ event: 'error', data: { type: 'error', error: { type: sc.errorType, message: 'mock error' } } }));
          break;
        }
        if (sc.kind === 'drop' && i === sc.afterEvents) {
          res.socket?.destroy();
          return;
        }
        if (i >= head.length && i < head.length + deltas.length && perDeltaMs > 0) await sleep(perDeltaMs);
        if (closed) return;
        await write(frame(all[i] as ScriptedEvent));
        if (sc.kind === 'pauseAfterStart' && i === 0) await sleep(sc.pauseMs);
      }
    } finally {
      stopPings();
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
      received.push(rec);
      requestCount++;
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
