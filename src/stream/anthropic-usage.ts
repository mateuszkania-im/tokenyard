import type { SseEvent } from './sse.js';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
export type UsageSource = 'final' | 'partial' | 'estimated' | 'none';
export interface UsageResult {
  usage: Usage | null;
  source: UsageSource;
  midStreamError: string | null;
  sawStop: boolean;
  streamedChars: number;
  responseModel: string | null;
  /** True when source is 'final' but `usage.output` was estimated from streamed chars (no message_delta output count). */
  outputEstimated?: boolean;
  /** The usage reported `speed: "fast"`: priced at the model's fast rates. Absent otherwise. */
  fast?: true;
  /** `usage.server_tool_use` counts by price table tool name (`web_search_requests` is `web_search`). Absent when none. */
  serverToolUses?: Record<string, number>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Billing details beside the token buckets: fast mode and server tool uses (cumulative, so later values replace). */
interface Extras {
  fast: boolean;
  web: number;
}

function applyExtras(x: Extras, raw: unknown): void {
  if (!isObj(raw)) return;
  if (typeof raw.speed === 'string') x.fast = raw.speed === 'fast';
  const web = isObj(raw.server_tool_use) ? num(raw.server_tool_use.web_search_requests) : undefined;
  if (web !== undefined) x.web = web;
}

function extrasOf(x: Extras): Pick<UsageResult, 'fast' | 'serverToolUses'> {
  return { ...(x.fast ? { fast: true as const } : {}), ...(x.web > 0 ? { serverToolUses: { web_search: x.web } } : {}) };
}

/** Overlay the fields present in an Anthropic usage object onto u. Returns true when output_tokens was present. */
function applyUsage(u: Usage, raw: unknown): boolean {
  if (!isObj(raw)) return false;
  const input = num(raw.input_tokens);
  if (input !== undefined) u.input = input;
  const read = num(raw.cache_read_input_tokens);
  if (read !== undefined) u.cacheRead = read;
  const cc = raw.cache_creation;
  const w5 = isObj(cc) ? num(cc.ephemeral_5m_input_tokens) : undefined;
  const w1 = isObj(cc) ? num(cc.ephemeral_1h_input_tokens) : undefined;
  if (w5 !== undefined || w1 !== undefined) {
    u.cacheWrite5m = w5 ?? 0;
    u.cacheWrite1h = w1 ?? 0;
  } else {
    const total = num(raw.cache_creation_input_tokens);
    if (total !== undefined) {
      u.cacheWrite5m = total;
      u.cacheWrite1h = 0;
    }
  }
  const output = num(raw.output_tokens);
  if (output !== undefined) u.output = output;
  return output !== undefined;
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

export class AnthropicUsageAccumulator {
  private usage: Usage | null = null;
  private deltaOutput = false;
  private sawStop = false;
  private chars = 0;
  private error: string | null = null;
  private model: string | null = null;
  private extras: Extras = { fast: false, web: 0 };

  onEvent(e: SseEvent): void {
    let d: unknown;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!isObj(d)) return;
    const type = typeof d.type === 'string' ? d.type : e.event;
    switch (type) {
      case 'message_start': {
        const m = d.message;
        if (!isObj(m)) return;
        if (typeof m.model === 'string') this.model = m.model;
        this.usage = emptyUsage();
        this.deltaOutput = false;
        applyUsage(this.usage, m.usage);
        applyExtras(this.extras, m.usage);
        break;
      }
      case 'message_delta': {
        if (!this.usage) return;
        if (applyUsage(this.usage, d.usage)) this.deltaOutput = true;
        applyExtras(this.extras, d.usage);
        break;
      }
      case 'content_block_delta': {
        const delta = d.delta;
        if (!isObj(delta)) return;
        for (const k of ['text', 'thinking', 'partial_json']) {
          const v = delta[k];
          if (typeof v === 'string') this.chars += v.length;
        }
        break;
      }
      case 'message_stop':
        this.sawStop = true;
        break;
      case 'error': {
        const err = d.error;
        this.error = isObj(err) && typeof err.type === 'string' ? err.type : 'error';
        break;
      }
      default:
        break;
    }
  }

  result(): UsageResult {
    const base = {
      midStreamError: this.error,
      sawStop: this.sawStop,
      streamedChars: this.chars,
      responseModel: this.model,
    };
    if (!this.usage) return { ...base, usage: null, source: 'none' };
    const usage = { ...this.usage };
    const extras = extrasOf(this.extras);
    if (!this.deltaOutput) {
      usage.output = Math.ceil(this.chars / 4);
      return this.sawStop ? { ...base, usage, source: 'final', outputEstimated: true, ...extras } : { ...base, usage, source: 'estimated', ...extras };
    }
    return { ...base, usage, source: this.sawStop ? 'final' : 'partial', ...extras };
  }
}

/** Usage from a non-streaming Messages response body. */
export function parseAnthropicJsonUsage(body: Buffer): UsageResult {
  const none: UsageResult = {
    usage: null,
    source: 'none',
    midStreamError: null,
    sawStop: false,
    streamedChars: 0,
    responseModel: null,
  };
  let d: unknown;
  try {
    d = JSON.parse(body.toString('utf8'));
  } catch {
    return none;
  }
  if (!isObj(d)) return none;
  const responseModel = typeof d.model === 'string' ? d.model : null;
  if (!isObj(d.usage)) return { ...none, responseModel };
  const usage = emptyUsage();
  applyUsage(usage, d.usage);
  const extras: Extras = { fast: false, web: 0 };
  applyExtras(extras, d.usage);
  return { ...none, usage, source: 'final', sawStop: true, responseModel, ...extrasOf(extras) };
}
