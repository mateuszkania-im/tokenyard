import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePolicyFiles, type PolicySource } from '../../src/policy/load-dir.js';
import type { RequestFeatures } from '../../src/policy/types.js';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'policy');
export const EXAMPLE_PRICES = readFileSync(join(EXAMPLE, 'prices.yaml'), 'utf8');

/** A PolicySource from policy YAML text, the example price table and an optional keys file. */
export function source(policyYaml: string, keysYaml = '[]'): PolicySource {
  return parsePolicyFiles('test', { 'policy.yaml': policyYaml, 'prices.yaml': EXAMPLE_PRICES, 'keys.yaml': keysYaml });
}

/** Wednesday 4 November 2026, 15:30 UTC. */
export const TS = Date.UTC(2026, 10, 4, 15, 30);

type FeaturesOver = Partial<Omit<RequestFeatures, 'attribution'>> & { attribution?: Partial<RequestFeatures['attribution']> };

export function features(over: FeaturesOver = {}): RequestFeatures {
  const { attribution, ...rest } = over;
  return {
    id: 'req_1',
    ts: TS,
    surface: 'anthropic-messages',
    traffic: 'coding-agent',
    billing: 'api',
    tenant: 'acme',
    team: 'web',
    keyId: 'k1',
    model: 'claude-opus-5-5',
    stream: true,
    inputTokensBound: 10_000,
    boundKind: 'bytes',
    maxOutputTokens: 1_000,
    serverTools: [],
    toolCount: 0,
    thinking: false,
    fastMode: false,
    guardrail: { hits: [] },
    ...rest,
    attribution: {
      session: null, agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null,
      repo: null, branch: null, ticket: null, feature: null,
      ...attribution,
    },
  };
}

export const HEAD = `apiVersion: tokenyard/v1
kind: Policy
metadata: { name: test }
providers:
  a: { format: anthropic, baseUrl: https://api.anthropic.com, credential: { env: A_KEY } }
  b: { format: anthropic, baseUrl: https://api.anthropic.com, credential: { env: B_KEY } }
  c: { format: anthropic, baseUrl: https://api.anthropic.com, credential: { env: C_KEY } }
tenants:
  acme: { teams: [web, data] }
`;
