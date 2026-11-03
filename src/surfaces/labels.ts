// Bounds for strings a client or an upstream chooses that reach trace records, spans and exports (security review B1).
// Pure: no I/O. A value outside its bound is replaced by a fixed word, never cut, so no part of free text survives.
import { sanitizeHeaderValue } from '../report/sanitize.js';

/** Server tool types are short lowercase identifiers (`web_search_20250305`, `code_interpreter`, `mcp`). */
const TOOL_TYPE = /^[a-z0-9_]{1,64}$/;
/** OpenAI `service_tier` values (https://platform.openai.com/docs/api-reference/responses/create). */
const SERVICE_TIERS: ReadonlySet<string> = new Set(['auto', 'default', 'flex', 'priority', 'scale']);
/** Provider error codes and types (`overloaded_error`, `rate_limit_exceeded`, `response.failed`). */
const ERROR_CODE = /^[a-z0-9_.]{1,64}$/;
/** Shape of a model id; used only where no price table is at hand (anonymizing traces written before B1). */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Rate limit header names the trace keeps (`anthropic-ratelimit-unified-*`). */
const RATE_LIMIT_HEADER = /^anthropic-ratelimit-unified-[a-z0-9-]{1,64}$/;

export const INVALID_TOOL_TYPE = '(invalid)';
export const OTHER = 'other';

export const toolTypeLabel = (type: string): string => (TOOL_TYPE.test(type) ? type : INVALID_TOOL_TYPE);
export const serviceTierLabel = (tier: string): string => (SERVICE_TIERS.has(tier) ? tier : OTHER);
export const errorCodeLabel = (code: string): string => (ERROR_CODE.test(code) ? code : 'error');
export const modelShapeLabel = (model: string): string => (model === '' || MODEL_ID.test(model) ? model : OTHER);

/** Only `anthropic-ratelimit-unified-*` names, values through the header sanitiser. */
export function rateLimitHeadersLabel(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (RATE_LIMIT_HEADER.test(k)) out[k] = sanitizeHeaderValue(String(v)).value;
  return out;
}
