// `npm run soak -- <memory|redis>` (V2): the shipped bundle (`bin/tokenyard.mjs serve`) under a moderate, mixed load
// against the mock providers for SOAK_MINUTES (default 45), sampled every 30 s for leaks: RSS and heap after a full GC,
// open fds, TCP sockets and handles, event loop delay, metric series, open reservations, trace files, Redis keys by
// class and memory. `memory` runs one gateway on the memory store; `redis` runs two gateways sharing one Redis (REDIS_URL,
// else a throwaway local container from scripts/local-redis.mjs), the documented way to scale out. After the load: a
// stream slot check per key, the store's reservations and slots, a clean SIGTERM exit. The verdicts use the thresholds
// in bench/soak-lib.ts; the result goes into bench/results.json under `soak`. Never calls a real provider.
//   npx tsx bench/soak.ts mock   (child: the mock providers)
import { type ChildProcess, execFile, fork, spawn } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from 'redis';
import { parse, stringify } from 'yaml';
import { isLoopbackRedisUrl, startLocalRedis } from '../scripts/local-redis.mjs';
import { hashKey } from '../src/edge/auth.js';
import { mulberry32, type ReceivedRequest, type Scenario } from '../src/mock/scenarios.js';
import { environment, gitState, percentiles, ROOT, runGit } from './lib.js';
import { classifyKey, type GatewayRun, type GatewaySample, judge, parseMetrics, type Point, SOAK_THRESHOLDS } from './soak-lib.js';

type Mode = 'memory' | 'redis';
const MINUTES = Number(process.env.SOAK_MINUTES ?? 45);
/**
 * Requests per second offered per gateway, Poisson arrivals (the bursts come on top). 100 kept one gateway at about
 * 54% of a core on this mix (so it saturates near 185 per second); 80 is about 43%: moderate load, as V2 asks (30 to 50%).
 */
const RATE = Number(process.env.SOAK_RATE ?? 80);
const SAMPLE_MS = 30_000;
const BIN = join(ROOT, 'bin', 'tokenyard.mjs');
const PROBE = join(ROOT, 'bench', 'soak-probe.mjs');
/** Per key: the policy's concurrent stream limit, checked after the load. */
const STREAMS_PER_KEY = 8;
const SESSION_BUDGET = 'session';
/** The soak policy's budgets, every level enforced; the end check compares each key's spent with its limit. */
const BUDGETS = [
  { name: 'org-month', scope: 'tenant', window: 'month', usd: 1_000_000, onExceed: 'block' },
  { name: 'team-day', scope: 'team', window: 'day', usd: 100_000, onExceed: 'block' },
  { name: 'dev-day', scope: 'key', window: 'day', usd: 10_000, onExceed: 'block' },
  { name: SESSION_BUDGET, scope: 'session', usd: 200, onExceed: 'block' },
];
const log = (s: string): void => console.error(`soak: ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------------------------------------------------------
// Mock child: both providers; `x-soak-mock` picks a fault, `x-soak-output` the output tokens.

function mockScenario(r: ReceivedRequest): Scenario {
  const h = (n: string): string | undefined => {
    const v = r.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const err = (status: number, type: string): Scenario => ({ kind: 'status', status, headers: {}, body: JSON.stringify({ type: 'error', error: { type, message: 'mock' } }) });
  switch (h('x-soak-mock')) {
    case '500':
      return err(500, 'api_error');
    case '529':
      return err(529, 'overloaded_error');
    case 'drop':
      return { kind: 'drop', afterEvents: 4 };
    case 'midstream':
      return { kind: 'midStreamError', afterEvents: 5, errorType: 'overloaded_error' };
    case 'slow':
      return { kind: 'ok', ttftMs: 2_000, tokensPerSec: 1_000, pingEveryMs: null, outputTokens: 50 };
    default:
      return { kind: 'ok', ttftMs: 80, tokensPerSec: 1_000, pingEveryMs: null, outputTokens: Number(h('x-soak-output') ?? 300) };
  }
}

async function mockMain(): Promise<void> {
  const { startAnthropicMock } = await import('../src/mock/anthropic.js');
  const { startOpenAIMock } = await import('../src/mock/openai.js');
  // As `tokenyard mock` runs them: no request kept.
  const a = await startAnthropicMock({ keepReceived: 0 });
  const o = await startOpenAIMock({ keepReceived: 0 });
  a.setScenario(mockScenario);
  o.setScenario(mockScenario);
  process.on('message', (m) => {
    if (m === 'mem') process.send?.({ rssMb: Math.round(process.memoryUsage.rss() / 1048576) });
  });
  process.on('SIGTERM', () => void Promise.all([a.close(), o.close()]).then(() => process.exit(0)));
  process.send?.({ anthropic: a.url, openai: o.url });
}

// ---------------------------------------------------------------------------------------------------------------------
// Policy: examples/policy with every provider on the mocks, two tenants, 40 developer keys, a noisy key and a service key.

interface Dev {
  key: string;
  keyId: string;
  tenant: string;
  team: string;
}

interface PolicySetup {
  dir: string;
  devs: Dev[];
  noisy: Dev;
  service: Dev;
}

function writePolicy(dir: string, mock: { anthropic: string; openai: string }): PolicySetup {
  mkdirSync(dir, { recursive: true });
  const example = join(ROOT, 'examples', 'policy');
  copyFileSync(join(example, 'prices.yaml'), join(dir, 'prices.yaml'));
  const p = parse(readFileSync(join(example, 'policy.yaml'), 'utf8')) as Record<string, any>;
  for (const [name, prov] of Object.entries(p.providers as Record<string, { baseUrl: string; credential: unknown }>)) {
    prov.baseUrl = name === 'openai' ? `${mock.openai}/v1` : mock.anthropic;
    prov.credential = { env: 'SOAK_PROVIDER_KEY' };
  }
  p.tenants = { acme: { teams: ['platform', 'web', 'data'] }, globex: { teams: ['core'] } };
  // Every level enforced. Sessions cycle through fixed ids (Load.ringId), so a session id collects spend for the whole
  // run: 200 USD keeps ordinary sessions under it for 45 minutes (25 USD did not: a third of the requests were refused
  // after half an hour). The heavy bursts (24 requests of about 10.6 USD each at once on one session) go over it.
  p.budgets = BUDGETS;
  // Room for the steady load; the noisy key's minute bursts go over both limits.
  p.rateLimits = [
    { name: 'dev-rpm', scope: 'key', rpm: 600, burst: 100 },
    { name: 'dev-streams', scope: 'key', concurrentStreams: STREAMS_PER_KEY },
  ];
  writeFileSync(join(dir, 'policy.yaml'), stringify(p));
  const teams: Array<[string, string]> = [['acme', 'platform'], ['acme', 'web'], ['acme', 'data'], ['globex', 'core']];
  const devs: Dev[] = Array.from({ length: 40 }, (_, i) => {
    const [tenant, team] = teams[i % teams.length] as [string, string];
    return { key: `ty_soak_dev_${String(i).padStart(2, '0')}`, keyId: `key_dev${i}`, tenant, team };
  });
  const noisy: Dev = { key: 'ty_soak_noisy', keyId: 'key_noisy', tenant: 'acme', team: 'platform' };
  const service: Dev = { key: 'ty_soak_service', keyId: 'key_service', tenant: 'acme', team: 'web' };
  const keys = [...devs, noisy].map((d) => ({ hash: hashKey(d.key), keyId: d.keyId, tenant: d.tenant, team: d.team, name: d.keyId, kind: 'developer', billing: 'api' }));
  keys.push({ hash: hashKey(service.key), keyId: service.keyId, tenant: service.tenant, team: service.team, name: 'support-bot', kind: 'service', billing: 'api' });
  writeFileSync(join(dir, 'keys.yaml'), keys.map((k) => `- ${JSON.stringify(k)}`).join('\n') + '\n');
  return { dir, devs, noisy, service };
}

// ---------------------------------------------------------------------------------------------------------------------
// Load: request kinds, bodies and headers shaped like Claude Code, Codex and a product service.

type Kind = 'main' | 'abort' | 'sub' | 'aux' | 'compaction' | 'codex' | 'codex-sync' | 'product' | 'secret' | 'bad-model' | 'hostile' | 'hostile-model' | 'fault' | 'noisy' | 'heavy' | 'slot-check';
const WEIGHTS: Array<[Kind, number]> = [
  ['main', 30], ['abort', 4], ['sub', 12], ['aux', 12], ['compaction', 1], ['codex', 14], ['codex-sync', 3], ['product', 4],
  ['secret', 2], ['bad-model', 2], ['hostile', 6], ['hostile-model', 2], ['fault', 3],
];
/** Session ids per key and pool, hostile session values, and sessions that send a secret (see Load.ringId). */
const SESSIONS_PER_KEY = 12;
const HOSTILE_SESSIONS = 300;
const SECRET_SESSIONS = 100;
/** Kinds whose socket errors are deliberate (client aborts, upstream drops). */
const ERRORS_EXPECTED: ReadonlySet<Kind> = new Set(['abort', 'fault']);

interface Session {
  id: string;
  turn: number;
  turns: number;
}

const SOURCE = 'export function add(a: number, b: number): number {\n  return a + b; // sum two numbers\n}\n';
const SYSTEM = `You are Claude Code, a coding agent. ${'Follow the repository conventions and keep changes small. '.repeat(120)}`;
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Task', 'WebSearch'].map((name) => ({ name, description: `${name} tool. ${'Use it carefully. '.repeat(20)}`, input_schema: { type: 'object', properties: { arg: { type: 'string' } } } }));

/** A Claude Code turn: the system prompt and tools, then `turns` tool round trips of ~3 KB, cached on a stable prefix. */
function messagesBody(o: { model: string; maxTokens: number; stream: boolean; turns: number; last: string; extraKb?: number }): Buffer {
  const messages: unknown[] = [];
  for (let i = 0; i < o.turns; i++) {
    messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { arg: `src/file${i}.ts` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: SOURCE.repeat(30) }] },
    );
  }
  if (o.extraKb) messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Summary so far: '.concat('x'.repeat(o.extraKb * 1024)) }] });
  messages.push({ role: 'user', content: [{ type: 'text', text: o.last, cache_control: { type: 'ephemeral' } }] });
  return Buffer.from(JSON.stringify({ model: o.model, max_tokens: o.maxTokens, stream: o.stream, system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], tools: TOOLS, messages: [{ role: 'user', content: 'Fix the failing test.' }, ...messages] }));
}

function responsesBody(o: { stream: boolean; turns: number; session: string }): Buffer {
  const input: unknown[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the failing test.' }] }];
  for (let i = 0; i < o.turns; i++) {
    input.push({ type: 'function_call', call_id: `call_${i}`, name: 'shell', arguments: JSON.stringify({ command: ['cat', `src/file${i}.ts`] }) }, { type: 'function_call_output', call_id: `call_${i}`, output: SOURCE.repeat(30) });
  }
  return Buffer.from(
    JSON.stringify({
      model: 'gpt-5.5',
      instructions: SYSTEM,
      input,
      tools: [{ type: 'function', name: 'shell', description: 'run a command', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low', summary: 'auto' },
      store: false,
      stream: o.stream,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: o.session,
    }),
  );
}

/** Printable ASCII and Latin-1 (what Node lets through a header value), quotes, braces, percent signs and runs of spaces. */
function hostileValue(rng: () => number): string {
  const alphabet = 'abcXYZ019 {}"\\%:/._-*?<>|\t\u00e9\u00ff\u00a0';
  const n = 1 + Math.floor(rng() * 900);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return `h${s}`;
}

interface Planned {
  kind: Kind;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  stream: boolean;
  /** Abort the response this many ms after its first byte. */
  abortAfterMs?: number;
}

class Load {
  private rng: () => number;
  private sessions = new Map<string, Session[]>();
  private codexSessions = new Map<string, Session[]>();
  private n = 0;
  /** New sessions per key and pool cycle through this many ids, so per-session counter state stops growing (below). */
  private ring = new Map<string, number>();
  private readonly hostileSessions: string[];
  /**
   * Distinct (tenant, session) pairs the load sent (one budget-session key each: counter keys are per tenant, and the
   * secret and hostile session ids are sent by keys of both tenants), and the pairs that sent a secret (taint keys).
   */
  readonly sessionValues = new Set<string>();
  readonly taintedSessions = new Set<string>();

  constructor(private readonly setup: PolicySetup, seed: number) {
    this.rng = mulberry32(seed);
    this.hostileSessions = Array.from({ length: HOSTILE_SESSIONS }, () => hostileValue(this.rng));
  }

  /**
   * A session id from a fixed ring per key and prefix. Every distinct session id holds counter state until it has been
   * idle for sessions.idleTtlHours (24 h; the session budget level and the session marker), so with endless new ids that
   * state grows for the whole run and hides a real leak; with a ring it levels off (after about 15 minutes) and the Redis
   * key check bounds it by what was sent. The per-session cost is measured separately (bytes per key, docs/benchmarks.md).
   */
  private ringId(prefix: string, owner: string, size: number): string {
    const k = `${prefix}:${owner}`;
    const i = this.ring.get(k) ?? 0;
    this.ring.set(k, i + 1);
    return `${prefix}-${owner}-${i % size}`;
  }

  private id(prefix: string): string {
    return `${prefix}-${(++this.n).toString(36)}-${Math.floor(this.rng() * 1e9).toString(36)}`;
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)] as T;
  }

  /** A session of the key that is not finished; finished sessions are replaced, as a developer starts a new one. */
  private session(pool: Map<string, Session[]>, dev: Dev, prefix: string): Session {
    let list = pool.get(dev.keyId);
    if (!list) pool.set(dev.keyId, (list = []));
    while (list.length < 3) list.push({ id: this.ringId(prefix, dev.keyId, SESSIONS_PER_KEY), turn: 0, turns: 10 + Math.floor(this.rng() * 70) });
    const i = Math.floor(this.rng() * list.length);
    const s = list[i] as Session;
    s.turn++;
    if (s.turn >= s.turns) list.splice(i, 1);
    this.sessionValues.add(`${dev.tenant}\0${s.id}`);
    return s;
  }

  private ccHeaders(dev: Dev, session: string, cls: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-api-key': dev.key,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      'user-agent': 'claude-cli/2.1.316 (external, cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': session,
      'x-claude-code-request-class': cls,
      'x-claude-code-prompt-id': this.id('p'),
      ...extra,
    };
  }

  pickKind(): Kind {
    const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
    let x = this.rng() * total;
    for (const [k, w] of WEIGHTS) {
      x -= w;
      if (x < 0) return k;
    }
    return 'main';
  }

  plan(kind: Kind): Planned {
    const dev = this.pick(this.setup.devs);
    const messages = '/v1/messages?beta=true';
    switch (kind) {
      case 'main':
      case 'abort': {
        const s = this.session(this.sessions, dev, 'cc');
        const model = this.rng() < 0.7 ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
        const p: Planned = { kind, path: messages, stream: true, headers: this.ccHeaders(dev, s.id, 'main'), body: messagesBody({ model, maxTokens: 32_000, stream: true, turns: Math.min(s.turn, 40), last: `Turn ${s.turn}: continue.` }) };
        if (kind === 'abort') p.abortAfterMs = Math.floor(this.rng() * 200);
        return p;
      }
      case 'sub': {
        const s = this.session(this.sessions, dev, 'cc');
        const agent = this.id('agent');
        const headers = this.ccHeaders(dev, s.id, 'subagent', { 'x-claude-code-agent-id': agent, 'x-claude-code-parent-agent-id': 'main', 'x-claude-code-agent-type': this.pick(['Explore', 'general-purpose', 'Plan', 'my-reviewer']) });
        return { kind, path: messages, stream: true, headers: { ...headers, 'x-soak-output': '150' }, body: messagesBody({ model: this.rng() < 0.5 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', maxTokens: 16_000, stream: true, turns: 1 + Math.floor(this.rng() * 8), last: 'Explore the module.' }) };
      }
      case 'aux': {
        const s = this.session(this.sessions, dev, 'cc');
        return { kind, path: messages, stream: false, headers: { ...this.ccHeaders(dev, s.id, 'auxiliary'), 'x-soak-output': '20' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 512, messages: [{ role: 'user', content: 'Write a five word title for this session.' }] })) };
      }
      case 'compaction': {
        const s = this.session(this.sessions, dev, 'cc');
        return { kind, path: messages, stream: true, headers: { ...this.ccHeaders(dev, s.id, 'compaction'), 'x-soak-output': '800' }, body: messagesBody({ model: 'claude-sonnet-5-5', maxTokens: 20_000, stream: true, turns: 40, last: 'Summarise the conversation so far.', extraKb: 30 }) };
      }
      case 'codex':
      case 'codex-sync': {
        const s = this.session(this.codexSessions, dev, 'cx');
        const stream = kind === 'codex';
        return {
          kind,
          path: '/v1/responses',
          stream,
          headers: { authorization: `Bearer ${dev.key}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', originator: 'codex_exec', version: '0.130.0', session_id: s.id, 'user-agent': 'codex_exec/0.130.0 (Mac OS 26.0.0; arm64) unknown' },
          body: responsesBody({ stream, turns: Math.min(s.turn, 30), session: s.id }),
        };
      }
      case 'product': {
        const sv = this.setup.service;
        return {
          kind,
          path: '/v1/messages',
          stream: false,
          headers: { 'x-api-key': sv.key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-tokenyard-feature': 'support-summary', 'x-soak-output': '60' },
          body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: `Summarise ticket ${this.n}: the customer jane.doe${this.n % 50}@example.com cannot log in.` }] })),
        };
      }
      case 'secret': {
        // A session sends a key in its last turn: blocked, and the session is tainted (spec 6.6).
        const id = this.ringId('secret', 'all', SECRET_SESSIONS);
        this.sessionValues.add(`${dev.tenant}\0${id}`);
        this.taintedSessions.add(`${dev.tenant}\0${id}`);
        return { kind, path: messages, stream: true, headers: this.ccHeaders(dev, id, 'main'), body: messagesBody({ model: 'claude-sonnet-5-5', maxTokens: 8_000, stream: true, turns: 2, last: `deploy with ${['AKIA', 'IOSFODNN7EXAMPLE'].join('')} please` }) };
      }
      case 'bad-model': {
        const s = this.session(this.sessions, dev, 'cc');
        return { kind, path: messages, stream: false, headers: this.ccHeaders(dev, s.id, 'main'), body: Buffer.from(JSON.stringify({ model: 'gpt-4o', max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] })) };
      }
      case 'hostile':
      case 'hostile-model': {
        // Every attribution header the gateway reads, with values a hostile client chooses: new random values on every
        // request, except the session id, drawn from a fixed set of hostile values (see ringId).
        const id = this.pick(this.hostileSessions);
        this.sessionValues.add(`${dev.tenant}\0${id}`);
        const headers: Record<string, string> = {
          ...this.ccHeaders(dev, id, hostileValue(this.rng)),
          'x-claude-code-agent-type': hostileValue(this.rng),
          'x-claude-code-agent-id': hostileValue(this.rng),
          'x-claude-code-parent-agent-id': hostileValue(this.rng),
          'x-claude-code-prompt-id': hostileValue(this.rng),
          'x-tokenyard-repo': hostileValue(this.rng),
          'x-tokenyard-branch': hostileValue(this.rng),
          'x-tokenyard-ticket': hostileValue(this.rng),
          'x-tokenyard-feature': hostileValue(this.rng),
          'x-soak-output': '40',
        };
        const model = kind === 'hostile-model' ? `claude-haiku-${Math.floor(this.rng() * 1e12).toString(16)}` : 'claude-haiku-5-5';
        const stream = this.rng() < 0.5;
        return { kind, path: messages, stream, headers, body: messagesBody({ model, maxTokens: 4_000, stream, turns: 1, last: 'hi' }) };
      }
      case 'fault': {
        const s = this.session(this.sessions, dev, 'cc');
        const fault = this.pick(['500', '529', 'drop', 'midstream']);
        return { kind, path: messages, stream: true, headers: { ...this.ccHeaders(dev, s.id, 'main'), 'x-soak-mock': fault }, body: messagesBody({ model: 'claude-sonnet-5-5', maxTokens: 8_000, stream: true, turns: Math.min(s.turn, 20), last: 'go' }) };
      }
      default:
        throw new Error(`no plan for ${kind}`);
    }
  }

  /**
   * The noisy key, every minute: 12 slow streams at once (over its limit of 8 concurrent requests), and 30 s later 160
   * quick requests six at a time (over its burst of 100 and its 10 per second).
   */
  noisyBurst(part: 'streams' | 'rate'): Planned[] {
    const d = this.setup.noisy;
    const s = this.session(this.sessions, d, 'noisy');
    if (part === 'rate') return Array.from({ length: 160 }, () => ({ kind: 'noisy' as const, path: '/v1/messages', stream: false, headers: { ...this.ccHeaders(d, s.id, 'auxiliary'), 'x-soak-output': '10' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 256, messages: [{ role: 'user', content: 'title' }] })) }));
    return Array.from({ length: 12 }, () => ({ kind: 'noisy' as const, path: '/v1/messages', stream: true, headers: { ...this.ccHeaders(d, s.id, 'main'), 'x-soak-mock': 'slow' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'go' }] })) }));
  }

  /**
   * 24 requests at once on one session, three from each of eight keys of one tenant (under each key's limit of 8
   * concurrent requests): a 1.1 MB body and max_tokens 128,000 on Opus reserve about 10.6 USD each, so the 200 USD
   * session budget refuses some of them.
   */
  heavyBurst(): Planned[] {
    const id = this.ringId('heavy', 'all', 4);
    this.sessionValues.add(`acme\0${id}`);
    const devs = this.setup.devs.filter((d) => d.tenant === 'acme').slice(0, 8);
    const body = messagesBody({ model: 'claude-opus-5-5', maxTokens: 128_000, stream: false, turns: 2, last: 'Refactor everything.', extraKb: 1_100 });
    return devs.flatMap((dev) => Array.from({ length: 3 }, () => ({ kind: 'heavy' as const, path: '/v1/messages?beta=true', stream: false, headers: { ...this.ccHeaders(dev, id, 'main'), 'x-soak-output': '100' }, body })));
  }

  /**
   * A secret in the last turn of a new session, then a clean turn of the same session whose history holds that secret,
   * as Claude Code would send it next: the second must be refused (taint), wherever the first was sent.
   */
  taintPair(dev: Dev): [Planned, Planned] {
    const id = this.id('taint');
    this.sessionValues.add(`${dev.tenant}\0${id}`);
    this.taintedSessions.add(`${dev.tenant}\0${id}`);
    const secret = `deploy with ${['AKIA', 'IOSFODNN7EXAMPLE'].join('')} please`;
    const body = (messages: unknown[]): Buffer => Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 256, stream: false, messages }));
    const headers = this.ccHeaders(dev, id, 'main');
    return [
      { kind: 'secret', path: '/v1/messages', stream: false, headers, body: body([{ role: 'user', content: secret }]) },
      { kind: 'secret', path: '/v1/messages', stream: false, headers, body: body([{ role: 'user', content: secret }, { role: 'assistant', content: 'I will not use that.' }, { role: 'user', content: 'continue' }]) },
    ];
  }

  /** Per key, its stream limit plus one at once, each on a slow stream and a new session. */
  slotCheck(dev: Dev): Planned[] {
    return Array.from({ length: STREAMS_PER_KEY + 1 }, () => {
      const id = this.id('slots');
      this.sessionValues.add(`${dev.tenant}\0${id}`);
      return { kind: 'slot-check' as const, path: '/v1/messages', stream: true, headers: { ...this.ccHeaders(dev, id, 'main'), 'x-soak-mock': 'slow' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 256, stream: true, messages: [{ role: 'user', content: 'go' }] })) };
    });
  }
}

interface Result {
  kind: Kind;
  status: number | null;
  error: string | null;
  totalMs: number;
  /** For tokenyard's own refusals, what refused: budget, streams, rate, taint, secret, model or other. */
  reason: string | null;
}

/** The kind of one of tokenyard's own error answers, from its message. */
function refusal(body: string): string | null {
  const m = /"message":"tokenyard: ([^"]*)"/.exec(body)?.[1];
  if (m === undefined) return null;
  // The taint answer says "this session's history ... holds a secret that rule ... blocked earlier" (src/policy/resolve.ts).
  for (const [re, r] of [[/history[^"]* holds a secret/i, 'taint'], [/session-churn|new sessions per hour/i, 'session-churn'], [/budget/i, 'budget'], [/concurrent|stream/i, 'streams'], [/rate/i, 'rate'], [/taint/i, 'taint'], [/secret|credential/i, 'secret'], [/model|pric/i, 'model']] as const) if (re.test(m)) return r;
  return 'other';
}

function send(agent: Agent, base: string, p: Planned): Promise<Result> {
  const url = new URL(base);
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    let errBody = '';
    const finish = (status: number | null, error: string | null): void => {
      if (done) return;
      done = true;
      resolve({ kind: p.kind, status, error, totalMs: performance.now() - t0, reason: status !== null && status >= 400 ? refusal(errBody) : null });
    };
    let answered = false;
    const req = request({ host: url.hostname, port: url.port, method: 'POST', path: p.path, headers: { ...p.headers, 'content-length': String(p.body.length) }, agent }, (res) => {
      answered = true;
      let first = true;
      res.on('data', (c: Buffer) => {
        if ((res.statusCode ?? 0) >= 400 && errBody.length < 2048) errBody += c.toString('utf8');
        if (first && p.abortAfterMs !== undefined) setTimeout(() => (req.destroy(), finish(res.statusCode ?? null, 'aborted-by-client')), p.abortAfterMs);
        first = false;
      });
      res.on('end', () => finish(res.statusCode ?? null, null));
      res.on('error', (e: NodeJS.ErrnoException) => finish(res.statusCode ?? null, e.code ?? 'response-error'));
      res.on('close', () => finish(res.statusCode ?? null, res.complete ? null : 'closed-early'));
    });
    req.setTimeout(120_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    // A reset on a reused keep-alive socket before any answer is labelled as such (diagnosis; it still counts). One
    // Redis run had 4 resets on the 1.1 MB heavy requests; the cause is not known (docs/benchmarks.md, Soak).
    req.on('error', (e: NodeJS.ErrnoException) => finish(null, `${e.code ?? 'socket'}${req.reusedSocket && !answered ? ' on a reused socket' : ''}`));
    req.end(p.body);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Processes and sampling.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function getText(url: string, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

interface Gateway {
  instance: string;
  child: ChildProcess;
  url: string;
  opsPort: number;
  probePort: number;
  stderrPath: string;
  exit: Promise<number | null>;
  lastCpu: { at: number; us: number } | null;
}

async function startGateway(o: { instance: string; mode: Mode; policyDir: string; traceDir: string; runDir: string; redisUrl: string | null }): Promise<Gateway> {
  const opsPort = await freePort();
  const probePort = await freePort();
  const stderrPath = join(o.runDir, `${o.instance}.stderr.log`);
  const errFd = openSync(stderrPath, 'a');
  const child = spawn(
    process.execPath,
    ['--expose-gc', '--import', pathToFileURL(PROBE).href, BIN, 'serve', '--policy', o.policyDir, '--state-dir', join(o.runDir, `state-${o.instance}`), '--trace-dir', o.traceDir, '--port', '0', '--metrics-port', String(opsPort), '--store', o.mode, '--instance-id', o.instance],
    {
      cwd: o.runDir,
      // Fixed, public soak values; the Redis URL (with its password) goes through the environment, never argv.
      env: { ...process.env, TOKENYARD_TRACE_SALT: 'soak-trace-salt-not-a-secret', SOAK_PROVIDER_KEY: 'soak-not-a-key', SOAK_PROBE_PORT: String(probePort), ...(o.redisUrl ? { TOKENYARD_REDIS_URL: o.redisUrl } : {}) },
      stdio: ['ignore', 'pipe', errFd],
    },
  );
  closeSync(errFd);
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      out += c;
      const m = /^(http:\/\/\S+)$/m.exec(out);
      if (m) resolve(m[1] as string);
    });
    void exit.then((code) => reject(new Error(`gateway ${o.instance} exited with ${code}; see ${stderrPath}`)));
  });
  return { instance: o.instance, child, url, opsPort, probePort, stderrPath, exit, lastCpu: null };
}

/** Open file descriptors and TCP sockets of a process (lsof). */
async function lsofCounts(pid: number): Promise<{ fds: number; tcp: number }> {
  // Async, so a sample never holds up the arrival loop (open loop).
  const out = await new Promise<string>((resolve) => {
    execFile('lsof', ['-n', '-P', '-p', String(pid)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ''));
  });
  const lines = out.split('\n').slice(1).filter((l) => l.trim() !== '');
  // Numbered descriptors only (cwd, txt and mem mappings are not fds).
  const fds = lines.filter((l) => /^\S+\s+\d+\s+\S+\s+\d+[rwu]/.test(l));
  return { fds: fds.length, tcp: fds.filter((l) => /\sTCP\s/.test(l)).length };
}

function traceStats(dir: string, instance: string): { files: number; bytes: number; hours: number; maxFileBytes: number } {
  let files = 0;
  let bytes = 0;
  let maxFileBytes = 0;
  const hours = new Set<string>();
  const walk = (d: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(`.${instance}.ndjson`)) {
        const size = statSync(p).size;
        files++;
        bytes += size;
        maxFileBytes = Math.max(maxFileBytes, size);
        hours.add(`${d.slice(-10)}T${e.name.slice(0, 2)}`);
      }
    }
  };
  walk(dir);
  return { files, bytes, hours: hours.size, maxFileBytes };
}

interface ProbeReply {
  loop: { p50Ms: number; p99Ms: number; maxMs: number };
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  handles: Record<string, number>;
  uncaught: number;
  cpuUs: number;
}

async function sampleGateway(g: Gateway, t: number, traceDir: string): Promise<{ sample: GatewaySample; probe: ProbeReply; metrics: ReturnType<typeof parseMetrics>; cpuPct: number | null }> {
  const probe = JSON.parse((await getText(`http://127.0.0.1:${g.probePort}/sample`)).body) as ProbeReply;
  const metrics = parseMetrics((await getText(`http://127.0.0.1:${g.opsPort}/metrics`)).body);
  const { fds, tcp } = await lsofCounts(g.child.pid as number);
  const tr = traceStats(traceDir, g.instance);
  const now = performance.now();
  const cpuPct = g.lastCpu ? Math.round(((probe.cpuUs - g.lastCpu.us) / 1e3 / (now - g.lastCpu.at)) * 1000) / 10 : null;
  g.lastCpu = { at: now, us: probe.cpuUs };
  const handles = Object.values(probe.handles).reduce((s, n) => s + n, 0);
  return {
    probe,
    metrics,
    cpuPct,
    sample: {
      t: Math.round(t),
      rssMb: probe.rssMb,
      heapMb: probe.heapUsedMb,
      externalMb: probe.externalMb,
      fds,
      tcpSockets: tcp,
      handles,
      eventLoopP50Ms: probe.loop.p50Ms,
      eventLoopP99Ms: probe.loop.p99Ms,
      eventLoopMaxMs: probe.loop.maxMs,
      series: metrics.series,
      reservationsOpen: metrics.totals.tokenyard_reservations_open ?? 0,
      traceFiles: tr.files,
      traceBytes: tr.bytes,
    },
  };
}

type Redis = ReturnType<typeof createClient>;

async function redisKeys(r: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const reply = (await r.sendCommand(['SCAN', cursor, 'COUNT', '1000'])) as [string, string[]];
    cursor = String(reply[0]);
    keys.push(...reply[1].map(String));
  } while (cursor !== '0');
  return keys;
}

async function redisSample(r: Redis): Promise<{ keys: number; usedMemoryMb: number; byClass: Record<string, number> }> {
  const mem = Number(/used_memory:(\d+)/.exec(await r.info('memory'))?.[1] ?? 0);
  const keys = await redisKeys(r);
  const byClass: Record<string, number> = {};
  for (const k of keys) {
    const c = classifyKey(k, new Set([SESSION_BUDGET]));
    byClass[c] = (byClass[c] ?? 0) + 1;
  }
  return { keys: keys.length, usedMemoryMb: Math.round((mem / 1048576) * 100) / 100, byClass };
}

/** stderr lines a healthy soak writes: startup notices and policy loads. Anything else is reported. */
const EXPECTED_STDERR = [/^tokenyard: ops listener /, /^tokenyard: policy revision \S+ active$/, /^tokenyard: warm-up seeded /];

// ---------------------------------------------------------------------------------------------------------------------

interface Window {
  t: number;
  sent: number;
  byStatus: Record<string, number>;
  auxP50Ms: number | null;
}

async function main(mode: Mode): Promise<void> {
  // The checkout before anything starts: the bundle the gateways run is the one at this commit (see runGit).
  const gitAtStart = gitState();
  const runDir = mkdtempSync(join(tmpdir(), `tokenyard-soak-${mode}-`));
  const traceDir = join(runDir, 'traces');
  log(`run dir ${runDir}; ${MINUTES} min at ${RATE} req/s per gateway, ${mode === 'redis' ? 'two gateways sharing Redis' : 'one gateway, memory store'}`);
  let redisStop = (): void => undefined;
  let redisUrl: string | null = null;
  let redis: Redis | null = null;
  let redisVersion: string | null = null;
  if (mode === 'redis') {
    const given = process.env.REDIS_URL;
    if (given && !isLoopbackRedisUrl(given)) throw new Error('REDIS_URL must be a loopback Redis');
    const r = startLocalRedis();
    redisUrl = r.url;
    redisStop = r.stop;
    redis = createClient({ url: redisUrl });
    redis.on('error', () => undefined);
    await redis.connect();
    redisVersion = /redis_version:(\S+)/.exec(await redis.info('server'))?.[1] ?? null;
    if (Number(await redis.dbSize()) !== 0) throw new Error('the soak counts every key: give it an empty Redis');
  }
  const mock = fork(join(import.meta.dirname, 'soak.ts'), ['mock'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const mockUrls = await new Promise<{ anthropic: string; openai: string }>((resolve) => mock.once('message', (m) => resolve(m as { anthropic: string; openai: string })));
  const setup = writePolicy(join(runDir, 'policy'), mockUrls);
  const gateways: Gateway[] = [];
  // A failed or interrupted run keeps its trace files (the per-request evidence, such as the status and error class of
  // a reset request); a passing one removes them.
  let keepTraces = true;
  try {
    for (let i = 1; i <= (mode === 'redis' ? 2 : 1); i++) gateways.push(await startGateway({ instance: `soak000${i}`, mode, policyDir: setup.dir, traceDir, runDir, redisUrl }));
    const agents = gateways.map(() => new Agent({ keepAlive: true, maxSockets: 512 }));
    const load = new Load(setup, 2026_11_03);
    const results: Result[] = [];
    let inflight = 0;
    let rr = 0;
    const fire = (p: Planned): Promise<Result> => {
      const i = rr++ % gateways.length;
      inflight++;
      return send(agents[i] as Agent, (gateways[i] as Gateway).url, p).then((r) => {
        inflight--;
        results.push(r);
        return r;
      });
    };
    const drain = async (maxMs: number): Promise<void> => {
      const until = performance.now() + maxMs;
      while (inflight > 0 && performance.now() < until) await sleep(100);
    };

    // Prime (lazy pools, script loads, JIT) at a tenth of the rate, then idle: the baseline the end is compared with.
    log('prime 20 s');
    const primeEnd = performance.now() + 20_000;
    while (performance.now() < primeEnd) {
      void fire(load.plan(load.pickKind()));
      await sleep(1000 / Math.max(1, (RATE * gateways.length) / 10));
    }
    await drain(30_000);
    for (const a of agents) a.destroy();
    await sleep(10_000);
    const before = await Promise.all(gateways.map((g) => sampleGateway(g, -1, traceDir)));
    const redisBefore = redis ? await redisSample(redis) : null;
    results.length = 0;

    // The load: Poisson arrivals at RATE, the noisy burst every minute, the heavy burst every two minutes.
    const samples: GatewaySample[][] = gateways.map(() => []);
    const cpu: number[][] = gateways.map(() => []);
    const mockRss: Point[] = [];
    const redisSeries: Array<{ t: number; keys: number; usedMemoryMb: number; byClass: Record<string, number> }> = [];
    const windows: Window[] = [];
    const rng = mulberry32(7);
    const t0 = performance.now();
    const endAt = t0 + MINUTES * 60_000;
    let nextSample = t0 + SAMPLE_MS;
    let nextNoisy = t0 + 60_000;
    let nextRate = t0 + 75_000;
    let nextHeavy = t0 + 90_000;
    let windowStart = 0;
    let next = t0;
    let sampling = false;
    log(`load ${MINUTES} min`);
    while (performance.now() < endAt) {
      const now = performance.now();
      if (now >= next) {
        void fire(load.plan(load.pickKind()));
        next += -Math.log(1 - rng()) * (1000 / (RATE * gateways.length));
        continue;
      }
      if (now >= nextNoisy) {
        nextNoisy += 60_000;
        for (const p of load.noisyBurst('streams')) void fire(p);
      }
      if (now >= nextRate) {
        nextRate += 60_000;
        const queue = load.noisyBurst('rate');
        const worker = async (): Promise<void> => {
          for (let p = queue.shift(); p; p = queue.shift()) await fire(p);
        };
        for (let i = 0; i < 6; i++) void worker();
      }
      if (now >= nextHeavy) {
        nextHeavy += 120_000;
        for (const p of load.heavyBurst()) void fire(p);
      }
      if (now >= nextSample) {
        nextSample += SAMPLE_MS;
        // Sampled beside the arrivals, never awaited here: arrivals stay on their Poisson schedule. A sample still
        // running when the next is due makes that one skip.
        if (!sampling) {
          sampling = true;
          void sampleTick(now).catch((e: unknown) => log(`sample failed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => (sampling = false));
        }
        continue;
      }
      await sleep(Math.min(next, nextSample, nextNoisy, nextRate, nextHeavy) - performance.now());
    }
    while (sampling) await sleep(100);
    async function sampleTick(now: number): Promise<void> {
        const t = (now - t0) / 1000;
        const ss = await Promise.all(gateways.map((g) => sampleGateway(g, t, traceDir)));
        ss.forEach((s, i) => {
          samples[i]?.push(s.sample);
          if (s.cpuPct !== null) cpu[i]?.push(s.cpuPct);
        });
        const win = results.slice(windowStart);
        windowStart = results.length;
        const byStatus: Record<string, number> = {};
        for (const r of win) byStatus[r.error ?? String(r.status)] = (byStatus[r.error ?? String(r.status)] ?? 0) + 1;
        const aux = win.filter((r) => r.kind === 'aux' && r.status === 200 && r.error === null).map((r) => r.totalMs);
        windows.push({ t: Math.round(t), sent: win.length, byStatus, auxP50Ms: percentiles(aux).p50 });
        mock.send('mem');
        const m = await new Promise<{ rssMb: number }>((resolve) => mock.once('message', (x) => resolve(x as { rssMb: number })));
        mockRss.push({ t: Math.round(t), v: m.rssMb });
        if (redis) redisSeries.push({ t: Math.round(t), ...(await redisSample(redis)) });
        log(
          `t=${Math.round(t)}s inflight ${inflight} sent ${win.length} ${gateways.map((g, i) => { const s = ss[i]?.sample as GatewaySample; return `[${g.instance} cpu ${ss[i]?.cpuPct}% rss ${s.rssMb} heap ${s.heapMb} fds ${s.fds} tcp ${s.tcpSockets} handles ${s.handles} eld99 ${s.eventLoopP99Ms} series ${s.series} open ${s.reservationsOpen} traces ${s.traceFiles}/${Math.round(s.traceBytes / 1048576)}MB]`; }).join(' ')}${redis ? ` redis keys ${redisSeries.at(-1)?.keys} mem ${redisSeries.at(-1)?.usedMemoryMb}MB` : ''} statuses ${JSON.stringify(byStatus)}`,
        );
    }
    const loadResults = [...results];
    log(`load done; draining ${inflight}`);
    await drain(60_000);

    // Stream slots: every developer key admits its full limit at once, and one more is refused.
    log('stream slot check');
    let admitted = 0;
    let refusedExtra = 0;
    for (const dev of setup.devs) {
      const rs = await Promise.all(load.slotCheck(dev).map((p) => fire(p)));
      const ok = rs.filter((r) => r.status === 200).length;
      admitted += Math.min(ok, STREAMS_PER_KEY);
      if (rs.filter((r) => r.status === 429).length === 1) refusedExtra++;
    }
    // Session taint: the secret through the first gateway, the clean follow-up through the last one (with two gateways,
    // the other process; the taint set is in the shared store).
    const [secretTurn, followUp] = load.taintPair(setup.devs[0] as Dev);
    const first = await send(agents[0] as Agent, (gateways[0] as Gateway).url, secretTurn);
    const second = await send(agents[gateways.length - 1] as Agent, (gateways[gateways.length - 1] as Gateway).url, followUp);
    const taint = { gateways: gateways.length, refused: first.reason === 'secret' && second.status === 400 && second.reason === 'taint' };
    log(`taint check: secret ${first.status} ${first.reason}, follow-up ${second.status} ${second.reason}`);
    await drain(30_000);
    for (const a of agents) a.destroy();
    // Past one sweeper tick (30 s), the R11 latch re-read and every keep-alive timeout.
    await sleep(40_000);
    const after = await Promise.all(gateways.map((g, i) => sampleGateway(g, (samples[i]?.at(-1)?.t ?? 0) + 60, traceDir)));
    const redisAfter = redis ? await redisSample(redis) : null;
    let redisCheck = null as Parameters<typeof judge>[0]['redis'];
    if (redis && redisAfter) {
      const keys = await redisKeys(redis);
      let reserved = 0;
      let streamCount = 0;
      let budgetKeys = 0;
      const overLimit: string[] = [];
      for (const k of keys) {
        const c = classifyKey(k, new Set([SESSION_BUDGET]));
        if (c === 'budget-session' || c === 'budget-window') {
          reserved += Number((await redis.hGet(k, 'r')) ?? 0);
          // Every level is enforced: spent (both gateways' settlements) must be within the level's limit.
          const name = decodeURIComponent(k.split(':')[3] ?? '');
          const limit = (BUDGETS.find((b) => b.name === name)?.usd ?? 0) * 1_000_000;
          const spent = Number((await redis.hGet(k, 's')) ?? 0);
          budgetKeys++;
          if (spent > limit) overLimit.push(`${k} ${spent} > ${limit}`);
        }
        if (c === 'streams') streamCount += Number((await redis.get(k)) ?? 0) > 0 ? 1 : 0;
      }
      const devCount = setup.devs.length + 2;
      redisCheck = {
        reservationKeys: redisAfter.byClass.reservation ?? 0,
        deadlineKeys: redisAfter.byClass.deadlines ?? 0,
        streamKeys: streamCount,
        reservedMicroUsd: reserved,
        budgetKeys,
        overLimit,
        keysByClass: redisAfter.byClass,
        // What the load could create: one session level per (tenant, session) sent (plus each tenant's unattributed one), the window
        // levels of each key, team and tenant (one day and one month window each, twice if the run crossed midnight UTC),
        // one GCRA and one stream counter per key, one taint set per session that sent a secret.
        bounds: {
          'budget-session': load.sessionValues.size + 2,
          'budget-window': (devCount + 4 + 2) * 2,
          rate: devCount,
          streams: devCount,
          taint: load.taintedSessions.size,
          // S-V2-1: one marker per (tenant, session) admitted, one new-sessions GCRA per key.
          'session-marker': load.sessionValues.size,
          'new-sessions': devCount,
          'sweep-lock': 1,
          r11: 0,
          other: 0,
        },
      };
    }

    // Stop: SIGTERM, then the exit code (a clean shutdown flushes traces and closes the store).
    for (const g of gateways) g.child.kill('SIGTERM');
    const exits = await Promise.all(gateways.map((g) => Promise.race([g.exit, sleep(20_000).then(() => (g.child.kill('SIGKILL'), null))])));
    const runs: GatewayRun[] = gateways.map((g, i) => {
      const stderr = readFileSync(g.stderrPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const tr = traceStats(traceDir, g.instance);
      const b = before[i] as Awaited<ReturnType<typeof sampleGateway>>;
      const a = after[i] as Awaited<ReturnType<typeof sampleGateway>>;
      return {
        instance: g.instance,
        idleBefore: b.sample,
        idleAfter: a.sample,
        samples: samples[i] as GatewaySample[],
        sweptTotal: a.metrics.totals.tokenyard_swept_total ?? 0,
        tracesDropped: a.metrics.totals.tokenyard_traces_dropped_total ?? 0,
        traceHours: tr.hours,
        exitCode: exits[i] ?? null,
        unexpectedStderr: stderr.filter((l) => !EXPECTED_STDERR.some((re) => re.test(l))).slice(0, 20),
        uncaught: a.probe.uncaught,
      };
    });
    const socketErrors = loadResults.filter((r) => r.error !== null && !ERRORS_EXPECTED.has(r.kind)).length;
    const verdicts = judge({
      gateways: runs,
      latency: windows.filter((w) => w.auxP50Ms !== null).map((w) => ({ t: w.t, v: w.auxP50Ms as number })),
      slotCheck: { keys: setup.devs.length, admitted, expectedAdmitted: setup.devs.length * STREAMS_PER_KEY, refusedExtra, expectedRefused: setup.devs.length },
      redis: redisCheck,
      control: mockRss,
      taint,
      failedRequests: { socket: socketErrors },
    });
    for (const v of verdicts) log(`${v.ok ? 'PASS' : 'FAIL'} ${v.check}: ${v.measured} (threshold: ${v.threshold})`);

    const byKind: Record<string, Record<string, number>> = {};
    for (const r of loadResults) {
      const k = (byKind[r.kind] ??= {});
      const s = r.error ?? (r.reason ? `${r.status} ${r.reason}` : String(r.status));
      k[s] = (k[s] ?? 0) + 1;
    }
    const avg = (xs: number[]): number => (xs.length === 0 ? 0 : Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10);
    const every5min = <T extends { t: number }>(xs: T[]): T[] => xs.filter((x, i) => i === xs.length - 1 || x.t % 300 < SAMPLE_MS / 1000);
    const run = {
      mode,
      gateways: gateways.length,
      startedAt: new Date(Date.now() - (performance.now() - t0)).toISOString(),
      minutes: MINUTES,
      offeredPerS: RATE * gateways.length,
      requests: loadResults.length,
      answeredPerS: Math.round((loadResults.length / (MINUTES * 60)) * 10) / 10,
      byKind,
      gatewayCpuPct: cpu.map(avg),
      socketErrorsOutsideAborts: socketErrors,
      passed: verdicts.every((v) => v.ok),
      verdicts,
      perGateway: runs.map((r, i) => ({
        instance: r.instance,
        idleBefore: r.idleBefore,
        idleAfter: r.idleAfter,
        traceHours: r.traceHours,
        traceMbPerHourOfLoad: Math.round(((r.idleAfter.traceBytes - r.idleBefore.traceBytes) / 1048576 / (MINUTES / 60)) * 10) / 10,
        cpuPct: avg(cpu[i] ?? []),
        exitCode: r.exitCode,
        unexpectedStderr: r.unexpectedStderr,
        every5min: every5min(r.samples),
      })),
      mockRssMb: { first: mockRss[0]?.v ?? null, last: mockRss.at(-1)?.v ?? null },
      redis: redis
        ? {
            version: redisVersion,
            before: redisBefore,
            after: redisAfter,
            bounds: redisCheck?.bounds,
            sessionValuesSent: load.sessionValues.size,
            bytesPerKey: redisAfter && redisBefore && redisAfter.keys > redisBefore.keys ? Math.round(((redisAfter.usedMemoryMb - redisBefore.usedMemoryMb) * 1048576) / (redisAfter.keys - redisBefore.keys)) : null,
            every5min: every5min(redisSeries),
          }
        : null,
    };
    writeFileSync(join(runDir, 'samples.json'), JSON.stringify({ run, samples, windows, mockRss, redisSeries }, null, 2));
    const file = join(ROOT, 'bench', 'results.json');
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    const env = environment(redisVersion);
    const git = runGit(gitAtStart, env.git);
    if (git.dirty) log(`the run is marked dirty: ${gitAtStart.commit === env.git.commit ? 'uncommitted changes to the benchmark inputs' : `HEAD moved from ${gitAtStart.commit} to ${env.git.commit} during the run`}`);
    const prev = (all.soak?.runs ?? []) as Array<{ mode: string }>;
    all.soak = {
      method: SOAK_METHOD,
      thresholds: SOAK_THRESHOLDS,
      environment: { git, node: env.node, hardware: env.hardware, os: env.os },
      runs: [...prev.filter((r) => r.mode !== mode), { ...run, git }].sort((x, y) => x.mode.localeCompare(y.mode)),
    };
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    log(`${run.passed ? 'PASSED' : 'FAILED'}; bench/results.json soak.${mode} written; raw samples in ${join(runDir, 'samples.json')}`);
    keepTraces = !run.passed;
    if (!run.passed) {
      process.exitCode = 1;
      log(`trace files kept for inspection in ${traceDir}`);
    }
  } finally {
    for (const g of gateways) if (g.child.exitCode === null) g.child.kill('SIGKILL');
    mock.kill('SIGTERM');
    await redis?.close().catch(() => undefined);
    redisStop();
    if (!keepTraces) rmSync(traceDir, { recursive: true, force: true });
  }
}

const SOAK_METHOD = [
  'The shipped bundle (bin/tokenyard.mjs serve, policy from a directory, traces written, ops listener on) runs under an open-loop load with Poisson arrivals against the mock providers on loopback: Claude Code main turns (streaming, growing cached context), subagents, auxiliary and compaction calls, Codex Responses (streaming and not), product traffic with PII, client aborts mid-stream, secret blocks with session taint, refused models, hostile attribution headers (up to 900 characters of quotes, braces, percent signs and Latin-1 on every attribution header, new on every request; session ids from a fixed set of 300 such values), upstream 500, 529, mid-stream errors and dropped connections, a noisy key over its rate and stream limits every minute and 24 requests with max_tokens 128,000 and a 1.1 MB body at once on one session every two minutes, over the enforced 200 USD session budget. New sessions cycle through a fixed set of ids per key, because each distinct session id holds counter state until it has been idle for 24 hours; that cost is measured on its own (Redis keys and bytes per key).',
  'A preloaded probe (bench/soak-probe.mjs; the bundle is unchanged) reports every 30 s the event loop delay since the previous sample, then RSS and heap used right after a full GC (--expose-gc), and active handles; lsof gives open descriptors and TCP sockets; /metrics gives the series count and open reservations; the trace directory gives files and bytes; Redis gives keys by class and used memory.',
  'Memory is judged after a 5 minute warm-up on heap used after a full GC plus external memory: the least-squares trend over the rest of the run, projected over it, and the last 5 minutes against the first 5 must each stay under 10%; RSS is judged the same way on the gateway minus the mock provider sampled at the same moments (a control process), against 10% of the gateway RSS. Descriptors, sockets and handles are compared idle before and after the load. After the load every key must admit its full concurrent stream limit at once with one more refused, no reservation may be open or left to the sweeper, and in Redis no reservation, deadline or stream count may remain.',
].join(' ');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.argv[2];
  if (role === 'mock') await mockMain();
  else if (role === 'memory' || role === 'redis') await main(role);
  else {
    console.error('usage: npm run soak -- <memory|redis>   (SOAK_MINUTES, default 45; SOAK_RATE requests/s per gateway, default 80)');
    process.exit(2);
  }
}
