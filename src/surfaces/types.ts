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
  /** `inference_geo` when it is a string (for example "us"); it selects a price modifier (`inferenceGeoUs`). Absent otherwise. */
  inferenceGeo?: string;
  parseError: boolean;
  /** Byte range of the last message in the original body, for the guardrail scanner. */
  lastTurn: { start: number; end: number } | null;
}
