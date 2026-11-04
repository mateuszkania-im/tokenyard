import { expect, test } from 'vitest';
import { GEN_AI, SEMCONV_COMMIT, TOKENYARD } from '../../src/telemetry/semconv.js';

test('semconv constants equal the snapshot pinned to SEMCONV_COMMIT', () => {
  expect(SEMCONV_COMMIT).toBe('9d1e748280e64cf5688d7f348bf86be24c3fce12');
  expect(Object.values(GEN_AI).sort()).toEqual(
    [
      'error.type',
      'gen_ai.conversation.id',
      'gen_ai.operation.name',
      'gen_ai.provider.name',
      'gen_ai.request.model',
      'gen_ai.request.stream',
      'gen_ai.response.finish_reasons',
      'gen_ai.response.model',
      'gen_ai.response.time_to_first_chunk',
      'gen_ai.usage.cache_read.input_tokens',
      'gen_ai.usage.cache_write.input_tokens',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
    ].sort(),
  );
  expect(Object.values(TOKENYARD).sort()).toEqual(
    [
      'tokenyard.added_ttfb_ms',
      'tokenyard.agent.id',
      'tokenyard.attempt',
      'tokenyard.cost.basis',
      'tokenyard.cost.usd',
      'tokenyard.decision',
      'tokenyard.policy.revision',
      'tokenyard.price_table',
      'tokenyard.provider',
      'tokenyard.request_class',
      'tokenyard.route',
      'tokenyard.team',
      'tokenyard.tenant',
    ].sort(),
  );
});
