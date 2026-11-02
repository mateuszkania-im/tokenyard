import { extractAnthropicFeatures } from './anthropic-messages.js';
import type { ExtractedFeatures } from './types.js';

/** `/v1/messages/count_tokens` takes the Messages request shape but produces no output and never streams. */
export function extractCountTokensFeatures(body: Buffer): ExtractedFeatures {
  return { ...extractAnthropicFeatures(body), stream: false, maxOutputTokens: null };
}
