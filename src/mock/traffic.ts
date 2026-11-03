// Synthetic coding-agent traffic for the demo (spec 13): 8 developers in 3 teams send Claude Code shaped sessions
// through a gateway. Everything is seeded; the caller owns the clock (the gateway and the mock read the same virtual
// clock), so the same seed gives the same requests at the same times. A few developers also run Codex sessions on the
// OpenAI Responses surface (Task 20), planned from their own seeded stream so the Claude Code traffic does not change.
import { mulberry32 } from './scenarios.js';

export interface DemoDeveloper {
  name: string;
  team: string;
  repo: string;
  /** Relative amount of work: scales sessions per day. */
  load: number;
}

export const DEMO_DEVELOPERS: readonly DemoDeveloper[] = [
  { name: 'alice', team: 'platform', repo: 'gateway-core', load: 1 },
  { name: 'bruno', team: 'platform', repo: 'infra-tools', load: 0.8 },
  { name: 'chen', team: 'platform', repo: 'gateway-core', load: 0.9 },
  { name: 'dana', team: 'web', repo: 'shop-web', load: 1.6 },
  { name: 'elif', team: 'web', repo: 'shop-web', load: 1.5 },
  { name: 'farid', team: 'web', repo: 'design-system', load: 1.3 },
  { name: 'gosia', team: 'data', repo: 'etl-jobs', load: 0.8 },
  { name: 'hiro', team: 'data', repo: 'etl-jobs', load: 0.7 },
];

/** The documented AWS example key (docs.aws.amazon.com); not a credential. */
export const FAKE_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
/** The developer who pastes it, and the day (0-based) of the paste. */
const SECRET_DEV = 'farid';
const SECRET_DAY = 2;

export const DEMO_START_MS = Date.UTC(2026, 9, 26, 0, 0, 0);
const DAY_MS = 86_400_000;

const WORDS = ['alpha', 'build', 'cache', 'diff', 'edit', 'file', 'grep', 'hook', 'index', 'jest', 'kind', 'lint', 'merge', 'node', 'patch', 'query', 'route', 'state', 'token', 'view'];
type Rng = () => number;
const text = (rng: Rng, words: number): string => Array.from({ length: words }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(' ');
const between = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const hex = (rng: Rng, n: number): string => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');

const toolDefs = (names: string[]): unknown[] =>
  names.map((name) => ({
    name,
    description: `${name} tool for the coding agent. `.repeat(20),
    input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  }));
const MAIN_TOOLS = toolDefs(['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'Write']);
const SUB_TOOLS = toolDefs(['Read', 'Grep', 'Glob']);

type Kind = 'main' | 'subagent' | 'compaction' | 'auxiliary';
interface Msg {
  role: string;
  content: Record<string, unknown>[];
}

/** One agent's growing conversation; `next` builds the request body of its next turn. */
class Conversation {
  private history: Msg[] = [];
  private n = 0;
  constructor(
    private readonly rng: Rng,
    private readonly o: { model: string; system: string; tools: unknown[]; maxTokens: number; thinking: boolean; resultWords: [number, number] },
  ) {}

  private body(messages: Msg[], model = this.o.model, maxTokens = this.o.maxTokens, thinking = this.o.thinking): Buffer {
    return Buffer.from(
      JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(thinking ? { thinking: { type: 'enabled', budget_tokens: 8000 } } : {}),
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: this.o.system, cache_control: { type: 'ephemeral' } },
        ],
        ...(this.o.tools.length > 0 ? { tools: this.o.tools } : {}),
        messages,
      }),
    );
  }

  private withMarker(): Msg[] {
    return this.history.map((m, i) => {
      if (i !== this.history.length - 1) return m;
      const blocks = [...m.content];
      const last = blocks.length - 1;
      blocks[last] = { ...(blocks[last] as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
      return { ...m, content: blocks };
    });
  }

  /** Next turn: a prompt (first turn, or `prompt` given) or the result of the previous tool call, then the assistant's reply is appended. */
  next(extraUserText?: string): Buffer {
    const i = this.n++;
    const [lo, hi] = this.o.resultWords;
    const big = this.rng() < 0.08;
    const content: Record<string, unknown>[] =
      i === 0
        ? [{ type: 'text', text: `Task: ${text(this.rng, between(this.rng, 20, 60))}` }]
        : [{ type: 'tool_result', tool_use_id: `toolu_${i - 1}`, content: text(this.rng, big ? hi * 3 : between(this.rng, lo, hi)) }];
    if (extraUserText !== undefined) content.push({ type: 'text', text: extraUserText });
    this.history.push({ role: 'user', content });
    const out = this.body(this.withMarker());
    this.history.push({
      role: 'assistant',
      content: [
        ...(this.o.thinking ? [{ type: 'thinking', thinking: text(this.rng, 30), signature: `sig_${i}_${hex(this.rng, 8)}` }] : []),
        { type: 'text', text: text(this.rng, 15) },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { input: text(this.rng, 4) } },
      ],
    });
    return out;
  }

  /** A compaction request: the whole conversation plus a summary instruction; the history then restarts from the summary. */
  compact(): Buffer {
    this.history.push({ role: 'user', content: [{ type: 'text', text: 'Summarize the conversation so far so work can continue in a fresh context.' }] });
    const out = this.body(this.withMarker(), this.o.model, 20000, false);
    this.history = [{ role: 'user', content: [{ type: 'text', text: `Summary of earlier work: ${text(this.rng, 300)}` }] }];
    this.n = 1;
    return out;
  }
}

function auxiliaryBody(rng: Rng, model: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      model,
      max_tokens: 512,
      stream: true,
      system: [{ type: 'text', text: 'Write a short title for this coding session.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: text(rng, between(rng, 20, 80)), cache_control: { type: 'ephemeral' } }] }],
    }),
  );
}

/**
 * One Codex session's growing Responses input: the prompt, then a shell call and its output per turn, shaped like
 * Codex's own requests (instructions, function tools, `store: false`, no `max_output_tokens`). Reasoning items with
 * `encrypted_content` are left out, so the demo stays on the bytes input bound.
 */
class CodexConversation {
  private input: Record<string, unknown>[] = [];
  private n = 0;
  constructor(
    private readonly rng: Rng,
    private readonly o: { model: string; instructions: string; sessionId: string },
  ) {}

  next(): Buffer {
    const i = this.n++;
    if (i === 0) this.input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Task: ${text(this.rng, between(this.rng, 20, 60))}` }] });
    else this.input.push({ type: 'function_call_output', call_id: `call_${i - 1}`, output: text(this.rng, between(this.rng, 100, 700)) });
    const out = Buffer.from(
      JSON.stringify({
        model: this.o.model,
        instructions: this.o.instructions,
        input: this.input,
        tools: CODEX_TOOLS,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { effort: 'medium', summary: 'auto' },
        store: false,
        stream: true,
        include: [],
        prompt_cache_key: this.o.sessionId,
      }),
    );
    this.input.push({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', text(this.rng, 4)] }), call_id: `call_${i}` });
    return out;
  }
}

const CODEX_TOOLS = [
  { type: 'function', name: 'shell', description: 'Runs a shell command and returns its output. '.repeat(10), strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } },
  { type: 'custom', name: 'apply_patch', description: 'Applies a patch to files in the workspace. '.repeat(10) },
];
/** Developers who also use Codex, and the models they pick. */
const CODEX_DEVS: ReadonlyArray<{ name: string; models: readonly string[] }> = [
  { name: 'gosia', models: ['gpt-5.4-mini', 'gpt-5.3-codex'] },
  { name: 'hiro', models: ['gpt-5.4-mini'] },
];

interface Planned {
  at: number;
  order: number;
  session: Session;
  kind: Kind;
  agent: string | null;
  parent: string | null;
  agentType: string | null;
  promptId: string;
  /** Builds the body when the request is due (conversations are advanced in time order only). */
  build(): Buffer;
}

interface Session {
  dev: DemoDeveloper;
  /** The coding agent: Claude Code on /v1/messages, or Codex on /v1/responses. */
  client: 'claude-code' | 'codex';
  id: string;
  branch: string;
  ticket: string;
  /** Requests the session may have rejected before the developer gives up. */
  tolerance: number;
  failures: number;
}

export interface TrafficOptions {
  /** One gateway, or several replicas: requests go to them in turn. */
  gatewayUrl: string | readonly string[];
  /** Plaintext tokenyard key per developer name (DEMO_DEVELOPERS). */
  keys: Record<string, string>;
  seed: number;
  days: number;
  /** First instant of day 0 (default DEMO_START_MS). */
  startMs?: number;
  /** Called with each request's virtual time before it is sent: the gateway and the mock read the same clock. */
  setTime?(ms: number): void;
  /** Awaited after each response, so a caller can wait until the request is fully accounted before the next one starts. */
  afterRequest?(): Promise<void>;
}

const MODELS = { main: 'claude-opus-5-5', subagent: 'claude-sonnet-5-5', compaction: 'claude-opus-5-5', auxiliary: 'claude-sonnet-5-5' } as const;

function planSession(rng: Rng, dev: DemoDeveloper, startAt: number, secret: boolean, out: Planned[], counter: { n: number }): Session {
  const session: Session = {
    dev,
    client: 'claude-code',
    id: `${hex(rng, 8)}-${hex(rng, 4)}-${hex(rng, 4)}-${hex(rng, 4)}-${hex(rng, 12)}`,
    branch: `feat/WEB-${between(rng, 100, 999)}`,
    ticket: '',
    tolerance: secret ? 2 : 1,
    failures: 0,
  };
  session.ticket = /WEB-\d+/.exec(session.branch)?.[0] ?? '';
  const system = text(mulberry32(hashString(dev.repo)), 700);
  const main = new Conversation(rng, { model: MODELS.main, system, tools: MAIN_TOOLS, maxTokens: 32000, thinking: true, resultWords: [150, 900] });
  const mainAgent = `agent-${hex(rng, 10)}`;
  const turns = between(rng, 8, 26);
  const compactAt = turns >= 16 && rng() < 0.4 ? Math.floor(turns * 0.6) : -1;
  const secretTurn = secret ? 3 : -1;
  const add = (p: Omit<Planned, 'order' | 'session'>): void => {
    out.push({ ...p, order: counter.n++, session });
  };
  let t = startAt;
  let promptId = `prompt-${hex(rng, 10)}`;
  add({ at: t, kind: 'auxiliary', agent: null, parent: null, agentType: null, promptId, build: () => auxiliaryBody(rng, MODELS.auxiliary) });
  t += between(rng, 2, 6) * 1000;
  for (let i = 0; i < turns; i++) {
    if (i > 0 && i % 6 === 0) promptId = `prompt-${hex(rng, 10)}`;
    const pid = promptId;
    const pasted = i === secretTurn ? `The deploy fails with this config, can you check it?\naws_access_key_id = ${FAKE_AWS_KEY}\nregion = eu-west-1` : undefined;
    add({ at: t, kind: 'main', agent: mainAgent, parent: null, agentType: null, promptId: pid, build: () => main.next(pasted) });
    if (i === compactAt) {
      t += between(rng, 5, 15) * 1000;
      add({ at: t, kind: 'compaction', agent: mainAgent, parent: null, agentType: null, promptId: pid, build: () => main.compact() });
    }
    if (i > 0 && i % 8 === 0) add({ at: t + 1500, kind: 'auxiliary', agent: null, parent: null, agentType: null, promptId: pid, build: () => auxiliaryBody(rng, MODELS.auxiliary) });
    if (i >= 2 && rng() < 0.22) {
      const subs = between(rng, 1, 3);
      for (let s = 0; s < subs; s++) {
        const sub = new Conversation(rng, { model: MODELS.subagent, system: text(rng, 250), tools: SUB_TOOLS, maxTokens: 16000, thinking: false, resultWords: [100, 500] });
        const agent = `agent-${hex(rng, 10)}`;
        const agentType = rng() < 0.6 ? 'Explore' : 'general-purpose';
        let st = t + between(rng, 2, 6) * 1000;
        for (let k = between(rng, 3, 6); k > 0; k--) {
          add({ at: st, kind: 'subagent', agent, parent: mainAgent, agentType, promptId: pid, build: () => sub.next() });
          st += between(rng, 3, 14) * 1000;
        }
        t = Math.max(t, st - 5000);
      }
    }
    t += between(rng, 6, 45) * 1000;
  }
  return session;
}

/** A Codex session: one prompt and `turns - 1` shell results, one request each. */
function planCodexSession(rng: Rng, dev: DemoDeveloper, model: string, startAt: number, out: Planned[], counter: { n: number }): Session {
  const id = `${hex(rng, 8)}-${hex(rng, 4)}-7${hex(rng, 3)}-${hex(rng, 4)}-${hex(rng, 12)}`;
  const session: Session = { dev, client: 'codex', id, branch: `feat/WEB-${between(rng, 100, 999)}`, ticket: '', tolerance: 1, failures: 0 };
  session.ticket = /WEB-\d+/.exec(session.branch)?.[0] ?? '';
  const conv = new CodexConversation(rng, { model, instructions: text(mulberry32(hashString(`codex:${dev.repo}`)), 500), sessionId: id });
  let t = startAt;
  for (let i = between(rng, 4, 10); i > 0; i--) {
    out.push({ at: t, order: counter.n++, session, kind: 'main', agent: null, parent: null, agentType: null, promptId: '', build: () => conv.next() });
    t += between(rng, 5, 40) * 1000;
  }
  return session;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Plans every session of `days` days, then sends the requests to the gateway one at a time in time order, setting the
 * virtual clock before each. A session whose request is refused (a budget, a secret block) stops once its developer's
 * patience runs out: the next request after a pasted secret is refused too (the secret is still in the history), then
 * the developer gives up; any other refusal ends the session at once.
 */
export async function generateTraffic(o: TrafficOptions): Promise<{ requests: number; sessions: number }> {
  const rng = mulberry32(o.seed ^ 0x9e3779b9);
  const startMs = o.startMs ?? DEMO_START_MS;
  const planned: Planned[] = [];
  const counter = { n: 0 };
  const sessions: Session[] = [];
  for (let d = 0; d < o.days; d++) {
    const dayStart = startMs + d * DAY_MS;
    const weekend = new Date(dayStart).getUTCDay() % 6 === 0;
    for (const dev of DEMO_DEVELOPERS) {
      const n = Math.floor(dev.load * (weekend ? 0.3 : 1.7) + rng());
      for (let s = 0; s < n; s++) {
        const startAt = dayStart + (8 + s * 4) * 3_600_000 + between(rng, 0, 90) * 60_000 + between(rng, 0, 59) * 1000;
        const secret = dev.name === SECRET_DEV && d === SECRET_DAY && s === 0;
        sessions.push(planSession(rng, dev, startAt, secret, planned, counter));
      }
    }
  }
  // Codex sessions come from their own stream, so adding them leaves the Claude Code traffic as it was.
  const codexRng = mulberry32(o.seed ^ 0x5bd1e995);
  for (let d = 0; d < o.days; d++) {
    const dayStart = startMs + d * DAY_MS;
    if (new Date(dayStart).getUTCDay() % 6 === 0) continue;
    for (const c of CODEX_DEVS) {
      const dev = DEMO_DEVELOPERS.find((x) => x.name === c.name);
      if (!dev || codexRng() < 0.4) continue;
      const model = c.models[Math.floor(codexRng() * c.models.length)] as string;
      const startAt = dayStart + 14 * 3_600_000 + between(codexRng, 0, 180) * 60_000;
      sessions.push(planCodexSession(codexRng, dev, model, startAt, planned, counter));
    }
  }
  planned.sort((a, b) => a.at - b.at || a.order - b.order);

  let requests = 0;
  const urls = typeof o.gatewayUrl === 'string' ? [o.gatewayUrl] : o.gatewayUrl;
  if (urls.length === 0) throw new Error('generateTraffic: no gateway URL');
  const stopped = new Set<Session>();
  for (const p of planned) {
    const s = p.session;
    if (stopped.has(s)) continue;
    const body = p.build();
    o.setTime?.(p.at);
    const codex = s.client === 'codex';
    const headers: Record<string, string> = codex
      ? {
          authorization: `Bearer ${o.keys[s.dev.name] ?? ''}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          originator: 'codex_cli_rs',
          version: '0.130.0',
          session_id: s.id,
          'user-agent': 'codex_cli_rs/0.130.0 (Mac OS 26.0.0; arm64) iTerm.app',
          'x-tokenyard-repo': s.dev.repo,
          'x-tokenyard-branch': s.branch,
          'x-tokenyard-ticket': s.ticket,
        }
      : {
          'x-api-key': o.keys[s.dev.name] ?? '',
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'user-agent': 'claude-cli/2.1.0 (external, cli)',
          'x-claude-code-session-id': s.id,
          'x-claude-code-request-class': p.kind,
          'x-claude-code-prompt-id': p.promptId,
          'x-tokenyard-repo': s.dev.repo,
          'x-tokenyard-branch': s.branch,
          'x-tokenyard-ticket': s.ticket,
          ...(p.agent ? { 'x-claude-code-agent-id': p.agent } : {}),
          ...(p.parent ? { 'x-claude-code-parent-agent-id': p.parent } : {}),
          ...(p.agentType ? { 'x-claude-code-agent-type': p.agentType } : {}),
        };
    const res = await fetch(`${urls[requests % urls.length]}${codex ? '/v1/responses' : '/v1/messages'}`, { method: 'POST', headers, body: new Uint8Array(body) });
    await res.arrayBuffer();
    requests++;
    await o.afterRequest?.();
    if (res.status >= 400 && ++s.failures >= s.tolerance) stopped.add(s);
  }
  return { requests, sessions: sessions.length };
}
