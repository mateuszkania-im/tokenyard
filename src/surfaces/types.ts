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
  blockTypes: string[];
  expandsServerSide: boolean;
  parseError: boolean;
  /** Byte range of the last message in the original body, for the guardrail scanner. */
  lastTurn: { start: number; end: number } | null;
}
