// Usage of an OpenAI Responses answer (spec 5.4). Pure: no I/O.
import type { Usage, UsageResult } from './anthropic-usage.js';
import type { SseEvent } from './sse.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Terminal events: each carries the whole response object, with `usage` when the provider reported one. */
const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * A Responses `usage` object as the four buckets (shape pinned by the R3 fixture, a real Codex 0.166.0 capture):
 * `input_tokens` counts the cached tokens, so `input_tokens_details.cached_tokens` is the cache read and the rest is
 * input. `input_tokens_details.cache_write_tokens` (seen only as 0 so far) is billed as a cache write on top of that
 * (`cacheWrite5m`) until its semantics are confirmed: never less than a subset reading would bill (ruling). The
 * estimator covers it on this surface. `output_tokens` includes the reasoning tokens. Null without `input_tokens`.
 */
function toUsage(raw: unknown): Usage | null {
  if (!isObj(raw)) return null;
  const input = num(raw.input_tokens);
  if (input === undefined) return null;
  const details = isObj(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const cached = Math.min(input, num(details.cached_tokens) ?? 0);
  return { input: input - cached, cacheRead: cached, cacheWrite5m: num(details.cache_write_tokens) ?? 0, cacheWrite1h: 0, output: num(raw.output_tokens) ?? 0 };
}

/**
 * Usage comes only in the terminal event (`response.completed`, `response.incomplete`, `response.failed`). A stream
 * that started (`response.created`) and ends without usage (cut off, or `response.failed` without it) is `partial`
 * with no usage: the prompt and the hidden reasoning tokens are unknown, so the gateway settles it at the reservation
 * (ruling S20-2). The streamed text is still counted in `streamedChars`.
 */
export class ResponsesUsageAccumulator {
  private started = false;
  private usage: Usage | null = null;
  private sawStop = false;
  private chars = 0;
  private error: string | null = null;
  private model: string | null = null;
  private tier: string | null = null;

  onEvent(e: SseEvent): void {
    let d: unknown;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!isObj(d)) return;
    const type = typeof d.type === 'string' ? d.type : (e.event ?? '');
    const response = isObj(d.response) ? d.response : null;
    if (response && typeof response.model === 'string') this.model = response.model;
    if (response && typeof response.service_tier === 'string') this.tier = response.service_tier;
    if (type === 'response.created' || type === 'response.in_progress') {
      this.started = true;
      return;
    }
    if (TERMINAL.has(type)) {
      this.started = true;
      this.sawStop = true;
      const u = toUsage(response?.usage);
      if (u) this.usage = u;
      if (type === 'response.failed') {
        const err = response?.error;
        this.error = isObj(err) && typeof err.code === 'string' ? err.code : 'response.failed';
      }
      return;
    }
    if (type === 'error') {
      this.error = typeof d.code === 'string' ? d.code : isObj(d.error) && typeof d.error.code === 'string' ? d.error.code : 'error';
      return;
    }
    // Every `*.delta` event carries generated text: output text, reasoning summaries, tool call arguments.
    if (type.endsWith('.delta') && typeof d.delta === 'string') this.chars += d.delta.length;
  }

  result(): UsageResult {
    const base = { midStreamError: this.error, sawStop: this.sawStop, streamedChars: this.chars, responseModel: this.model, ...(this.tier !== null ? { serviceTier: this.tier } : {}) };
    if (this.usage) return { ...base, usage: { ...this.usage }, source: 'final' };
    return { ...base, usage: null, source: this.started ? 'partial' : 'none' };
  }
}

/** Usage from a non-streaming Responses body (the response object). */
export function parseResponsesJsonUsage(body: Buffer): UsageResult {
  const none: UsageResult = { usage: null, source: 'none', midStreamError: null, sawStop: false, streamedChars: 0, responseModel: null };
  let d: unknown;
  try {
    d = JSON.parse(body.toString('utf8'));
  } catch {
    return none;
  }
  if (!isObj(d)) return none;
  const responseModel = typeof d.model === 'string' ? d.model : null;
  const tier = typeof d.service_tier === 'string' ? { serviceTier: d.service_tier } : {};
  const usage = toUsage(d.usage);
  return usage ? { ...none, usage, source: 'final', sawStop: true, responseModel, ...tier } : { ...none, responseModel, ...tier };
}
