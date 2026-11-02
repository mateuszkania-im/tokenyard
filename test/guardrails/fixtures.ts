// Positive and negative values per secret rule. Every value is built at runtime from parts, so no committed file holds
// a real-looking secret (check:secrets, push protection); the AWS value is AWS's own documented example key id.

/** Deterministic, high-entropy string over `alphabet` (a small LCG), so fixtures look like real tokens. */
export function tokenChars(n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', seed = 7): string {
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    out += alphabet[(x >>> 8) % alphabet.length];
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const join = (...parts: string[]): string => parts.join('');

export const RULE_FIXTURES: Record<string, { positive: string; negative: string }> = {
  'aws-access-key-id': { positive: 'AKIAIOSFODNN7EXAMPLE', negative: 'AKIAIOSFODNN7EXAMPL' },
  'github-pat': { positive: join('gh', 'p_', tokenChars(36)), negative: join('gh', 'p_', tokenChars(20)) },
  'github-oauth': { positive: join('gh', 'o_', tokenChars(36, undefined, 11)), negative: join('gh', 'x_', tokenChars(36, undefined, 11)) },
  'github-app-token': { positive: join('gh', 's_', tokenChars(36, undefined, 13)), negative: join('gh', 's_', tokenChars(35, undefined, 13), '!') },
  'github-fine-grained-pat': { positive: join('github', '_pat_', tokenChars(82, undefined, 17)), negative: join('github', '_pat_', tokenChars(30, undefined, 17)) },
  'slack-token': { positive: join('xo', 'xb-', '1234567890', '-', '9876543210', '-', tokenChars(24, undefined, 19)), negative: join('xo', 'xz-', '1234567890', '-', tokenChars(24, undefined, 19)) },
  'stripe-live-key': { positive: join('sk', '_live_', tokenChars(24, undefined, 23)), negative: join('sk', '_test_', tokenChars(24, undefined, 23)) },
  'private-key': {
    positive: join('-----BEGIN RSA ', 'PRIVATE KEY-----\n', tokenChars(64, B64, 29), '\n', tokenChars(64, B64, 31), '\n-----END RSA ', 'PRIVATE KEY-----'),
    negative: join('-----BEGIN ', 'PUBLIC KEY-----\n', tokenChars(64, B64, 29), '\n-----END ', 'PUBLIC KEY-----'),
  },
  jwt: {
    positive: join('eyJ', tokenChars(30, URLSAFE, 37), '.eyJ', tokenChars(40, URLSAFE, 41), '.', tokenChars(43, URLSAFE, 43)),
    negative: join('eyJ', tokenChars(30, URLSAFE, 37), '.notAPayload'),
  },
  'anthropic-api-key': {
    positive: join('sk-', 'ant-', 'api03-', tokenChars(93, URLSAFE, 47), 'AA'),
    // The repo's documented fake canary must not trip the rule.
    negative: join('sk-', 'ant-', 'test-CANARY-', tokenChars(60, URLSAFE, 47)),
  },
  'openai-api-key': { positive: join('sk-', 'proj-', tokenChars(64, URLSAFE, 53)), negative: join('sk-', 'proj-', tokenChars(12, URLSAFE, 53)) },
  'google-api-key': { positive: join('AI', 'za', tokenChars(35, URLSAFE, 59)), negative: join('AI', 'za', tokenChars(20, URLSAFE, 59)) },
  'tokenyard-key': { positive: join('ty_', 'live_', tokenChars(43, undefined, 61)), negative: join('ty_', 'live_', 'dev') },
  'generic-secret-assignment': {
    positive: join('api_key = "', tokenChars(40, undefined, 67), '"'),
    negative: join('api_key = "', 'a'.repeat(40), '"'),
  },
};
