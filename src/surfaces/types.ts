/** Read-only features of a request body. The body itself is never modified or re-serialised. */
export interface ExtractedFeatures {
  model: string | null;
  stream: boolean;
  maxOutputTokens: number | null;
  toolCount: number;
  thinking: boolean;
  serverTools: Array<{ type: string; maxUses: number | null }>;
  bodyBytes: number;
  prefixHash: string | null;
  /** Distinct content block types in `system` and `messages`, `tool_result` contents included. */
  blockTypes: string[];
  /**
   * True when the body has a field, tool or block that makes the provider add input on its side
   * (image or document blocks, `mcp_servers`, `container`, Anthropic-defined client tools) or one this
   * extractor does not know: the input bound then falls back to the context window (spec 7.3).
   */
  expandsServerSide: boolean;
  /** `speed` is present and not `"standard"`: priced at the model's fast mode rates. */
  fastMode: boolean;
  /**
   * OpenAI Responses `service_tier` unless it is `default` (standard pricing, then absent): `auto`, `priority`, `flex`,
   * `scale`, or `other` for any value outside the known tiers, which is never priced. An absent or null `service_tier`
   * is OpenAI's `auto` and is recorded as `auto` (FR-M2). Absent on the Anthropic surfaces. A named tier is priced only
   * from the model's `serviceTiers` (spec 7.3).
   */
  serviceTier?: string;
  /** `inference_geo` when it is a string (for example "us"); it selects a price modifier (`inferenceGeoUs`). Absent otherwise. */
  inferenceGeo?: string;
  /**
   * The body enables threshold compaction (a `compact_*` edit in `context_management.edits`): the provider may run a
   * compaction sampling iteration before each sampling iteration. Absent otherwise.
   */
  compaction?: true;
  parseError: boolean;
  /**
   * Byte range of the newest user-role message in the original body and its index in `messages`, for the guardrail
   * scanner (spec 5.3 step 5). Null without a user message.
   */
  lastTurn: { start: number; end: number; index: number } | null;
  /**
   * True when the body has a duplicate top-level `messages` key, or a message with a duplicate `role` or `content`:
   * JSON.parse keeps the last one, a provider may keep the first, so the guardrails scan such a body like a parse error.
   */
  ambiguousKeys?: true;
  /** Byte ranges of every element of `messages`, so guardrail hits can name a message index. Absent without messages. */
  messages?: Array<{ start: number; end: number }>;
}
