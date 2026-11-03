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

/**
 * Server tool types the providers document (S-V4-3), without a date suffix: Anthropic server tools and the
 * Anthropic-defined client tools, the gateway's own `mcp_servers`, and OpenAI built-in tools. Traces and exports keep
 * these in clear; any other type is client text.
 */
const KNOWN_SERVER_TOOLS: ReadonlySet<string> = new Set([
  // Anthropic: server tools, MCP connector, client tools with provider-side definitions
  'web_search', 'web_fetch', 'code_execution', 'tool_search_tool_regex', 'tool_search_tool_bm25', 'advisor', 'mcp_toolset', 'mcp_servers',
  'memory', 'bash', 'text_editor', 'str_replace_editor', 'str_replace_based_edit_tool', 'computer', 'browser_toolset',
  // OpenAI Responses built-in tools
  'web_search_preview', 'web_search_preview_2025_03_11', 'file_search', 'code_interpreter', 'mcp', 'image_generation', 'computer_use_preview', 'computer_use', 'local_shell', 'shell', 'apply_patch',
  INVALID_TOOL_TYPE,
]);
/** A tool type's name without its date suffix (`web_search_20250305` is `web_search`). */
export const toolTypeBase = (type: string): string => type.replace(/_\d{8}$/, '');
/** Whether `type` (after the ingest bound) is a server tool type a provider documents, with any date suffix. */
export const isKnownToolType = (type: string): boolean => KNOWN_SERVER_TOOLS.has(type) || KNOWN_SERVER_TOOLS.has(toolTypeBase(type));
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
