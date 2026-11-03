// Attribute names in one place (spec 12.2). GenAI names come from the semantic-conventions-genai repository at the commit
// below (status Development); a test fails when a name here changes without the snapshot in the test changing with it.

export const SEMCONV_COMMIT = '9d1e748280e64cf5688d7f348bf86be24c3fce12';

export const GEN_AI = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  requestStream: 'gen_ai.request.stream',
  conversationId: 'gen_ai.conversation.id',
  responseFinishReasons: 'gen_ai.response.finish_reasons',
  responseTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  usageCacheWriteInputTokens: 'gen_ai.usage.cache_write.input_tokens',
  errorType: 'error.type',
} as const;

/** The GenAI conventions define no cost attribute, so these are tokenyard's own. */
export const TOKENYARD = {
  costUsd: 'tokenyard.cost.usd',
  costBasis: 'tokenyard.cost.basis',
  priceTable: 'tokenyard.price_table',
  policyRevision: 'tokenyard.policy.revision',
  route: 'tokenyard.route',
  requestClass: 'tokenyard.request_class',
  agentId: 'tokenyard.agent.id',
  decision: 'tokenyard.decision',
  addedTtfbMs: 'tokenyard.added_ttfb_ms',
  tenant: 'tokenyard.tenant',
  team: 'tokenyard.team',
  provider: 'tokenyard.provider',
  attempt: 'tokenyard.attempt',
} as const;
