// `tokenyard demo`: mock Anthropic and OpenAI providers, a gateway with the example policy and synthetic traffic from 8 developers
// run in this process on a virtual clock; the traces are exported and replayed against the demo PR's policy (spec 13).
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../edge/server.js';
import { exportTraces } from '../ledger/export.js';
import { readLedger } from '../ledger/reader.js';
import { TraceWriter } from '../ledger/writer.js';
import { createMemoryStore } from '../limits/memory-store.js';
import { startAnthropicMock } from '../mock/anthropic.js';
import { startOpenAIMock } from '../mock/openai.js';
import { DEMO_DEVELOPERS, DEMO_START_MS, generateTraffic } from '../mock/traffic.js';
import type { Scenario } from '../mock/scenarios.js';
import { mulberry32 } from '../mock/scenarios.js';
import type { CompiledPolicy } from '../policy/types.js';
import { replay, type ReplayResult } from '../replay/engine.js';
import { renderTerminal } from '../replay/render-terminal.js';
import { DEMO_CREDENTIAL_ENV, demoKey, demoPolicies } from './policy.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Fixed so that traces are byte-identical for one seed. */
const TRACE_SALT = 'tokenyard-demo-salt';
const INSTANCE_ID = 'demo0001';
export const DEMO_DAYS = 7;

/**
 * Output tokens by request kind (max_tokens tells compaction and auxiliary apart; a Responses body without
 * max_output_tokens counts as a main turn), varied by the request body.
 */
function outputTokens(seed: number, body: Buffer): number {
  let max = 32000;
  try {
    const m = (JSON.parse(body.toString('utf8')) as { max_tokens?: unknown }).max_tokens;
    if (typeof m === 'number') max = m;
  } catch {
    // keep the default
  }
  const rng = mulberry32(seed ^ body.length ^ ((body.at(-97) ?? 0) << 8));
  if (max <= 512) return 30 + Math.floor(rng() * 90);
  if (max === 20000) return 1800 + Math.floor(rng() * 1400);
  return 120 + Math.floor(rng() * 1300);
}

export interface RecordedDemo {
  requests: number;
  sessions: number;
  base: CompiledPolicy;
  head: CompiledPolicy;
}

/** Runs the traffic through the gateway and writes the merged export (`.gz` is gzipped) to `traceFile`. */
export async function recordDemo(o: { seed: number; days?: number; traceFile: string }): Promise<RecordedDemo> {
  const days = o.days ?? DEMO_DAYS;
  let now = DEMO_START_MS;
  const clock = (): number => now;
  const prevKey = process.env[DEMO_CREDENTIAL_ENV];
  process.env[DEMO_CREDENTIAL_ENV] = 'demo-not-a-key';
  const dir = await mkdtemp(join(tmpdir(), 'tokenyard-demo-'));
  const scenario = (r: { body: Buffer }): Scenario => ({ kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: outputTokens(o.seed, r.body) });
  const mock = await startAnthropicMock({ now: clock });
  mock.setScenario(scenario);
  const openai = await startOpenAIMock({ scenario: { kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: 16 } });
  openai.setScenario(scenario);
  const { base, head } = demoPolicies(mock.url, openai.url);
  const store = createMemoryStore({ clock });
  const writer = new TraceWriter({ dir, instanceId: INSTANCE_ID, queueMax: 1_000_000, clock });
  let settled = 0;
  let ids = 0;
  const gw = createGateway({
    policy: () => base,
    store,
    traces: writer,
    traceSalt: TRACE_SALT,
    clock,
    newId: () => `req_${String(++ids).padStart(6, '0')}`,
    basePath: null,
    bodyCapBytes: 32 * 1024 * 1024,
    experimentalSubscription: false,
    onSettled: () => void settled++,
  });
  try {
    const url = await gw.listen(0, '127.0.0.1');
    let sent = 0;
    let heartbeatHour = -Infinity;
    const result = await generateTraffic({
      gatewayUrl: url,
      keys: Object.fromEntries(DEMO_DEVELOPERS.map((d) => [d.name, demoKey(d.name)])),
      seed: o.seed,
      days,
      setTime: (ms) => {
        // A gateway writes a heartbeat every minute, so every hour of the window has a file even when nobody is working.
        for (let h = Math.max(heartbeatHour + HOUR_MS, Math.ceil(DEMO_START_MS / HOUR_MS) * HOUR_MS); h <= ms; h += HOUR_MS) {
          now = h;
          writer.heartbeat();
          heartbeatHour = h;
        }
        now = ms;
      },
      // A request is accounted (settled and queued as a trace record) before the next one starts, so record order is fixed.
      afterRequest: async () => {
        sent++;
        for (let i = 0; settled < sent && i < 1000; i++) await new Promise<void>((r) => setImmediate(r));
      },
    });
    await writer.close();
    await exportTraces({ dir, sinceMs: DEMO_START_MS, untilMs: DEMO_START_MS + days * DAY_MS, out: o.traceFile });
    return { ...result, base, head };
  } finally {
    await gw.close();
    await mock.close();
    await openai.close();
    await rm(dir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env[DEMO_CREDENTIAL_ENV];
    else process.env[DEMO_CREDENTIAL_ENV] = prevKey;
  }
}

/** The whole demo: record the traffic, replay it against the demo PR, print the report to `out`. */
export async function runDemo(o: { out: NodeJS.WritableStream; seed: number; writeTraces?: string }): Promise<ReplayResult> {
  const dir = await mkdtemp(join(tmpdir(), 'tokenyard-demo-export-'));
  try {
    const file = join(dir, 'demo.ndjson.gz');
    o.out.write(`tokenyard demo: ${DEMO_DAYS} days of synthetic traffic from ${DEMO_DEVELOPERS.length} developers in 3 teams, through a gateway with examples/policy and mock Anthropic and OpenAI providers (seed ${o.seed}).\n`);
    const rec = await recordDemo({ seed: o.seed, traceFile: file });
    o.out.write(`${rec.requests} requests in ${rec.sessions} sessions recorded. Replaying them against examples/policy-head (the demo PR: compaction and auxiliary on a cheaper model, a tighter team budget).\n`);
    const result = await replay({ base: rec.base, head: rec.head, traces: readLedger([file]), sinceMs: null, tenant: null });
    if (o.writeTraces) {
      await copyFile(file, o.writeTraces);
      o.out.write(`Traces written to ${o.writeTraces}.\n`);
    }
    o.out.write(renderTerminal(result));
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
