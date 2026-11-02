import { afterEach, expect, test } from 'vitest';
import { pseudonym } from '../../../src/guardrails/hmac.js';
import type { TraceRecord } from '../../../src/ledger/record.js';
import { authHeaders, msgBody, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C16 Claude Code attribution headers are forwarded to upstream and land in the trace, session, agent, parent agent and prompt id as HMAC pseudonyms [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  const attribution = {
    'x-claude-code-session-id': '11111111-2222-3333-4444-555555555555',
    'x-claude-code-agent-id': 'agent-abc',
    'x-claude-code-parent-agent-id': 'agent-parent',
    'x-claude-code-request-class': 'subagent',
    'x-claude-code-agent-type': 'general-purpose',
    'x-claude-code-prompt-id': 'prompt-xyz',
  };
  const res = await send(stack.gw.url, { path: '/v1/messages?beta=true', headers: { ...authHeaders, ...attribution }, body: msgBody() });
  expect(res.status).toBe(200);
  const h = stack.mock.received[0]?.headers ?? {};
  for (const [k, v] of Object.entries(attribution)) expect(h[k], k).toBe(v);
});

const SALT = 'c16-salt';
const TRACE_ATTRIBUTION = {
  'x-claude-code-session-id': '11111111-2222-3333-4444-555555555555',
  'x-claude-code-agent-id': 'agent-abc',
  'x-claude-code-parent-agent-id': 'agent-parent',
  'x-claude-code-request-class': 'subagent',
  'x-claude-code-agent-type': 'general-purpose',
  'x-claude-code-prompt-id': 'prompt-xyz',
  'x-tokenyard-repo': 'shop',
  'x-tokenyard-branch': 'feat/ABC-1',
  'x-tokenyard-ticket': 'ABC-1',
  'x-tokenyard-feature': 'checkout',
  'user-agent': 'claude-cli/2.1.5 (external, cli)',
};

test('C16b the trace carries the attribution: ids pseudonymised, class, repo, branch, ticket and feature in clear, client from User-Agent [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  const records: Array<Omit<TraceRecord, 'instance' | 'seq'>> = [];
  stack = await startStack({ gw: { traces: { write: (r) => (records.push(r), true) }, traceSalt: SALT } });
  const res = await send(stack.gw.url, { path: '/v1/messages?beta=true', headers: { ...authHeaders, ...TRACE_ATTRIBUTION }, body: msgBody() });
  expect(res.status).toBe(200);
  await expect.poll(() => records.length).toBe(1);
  const r = records[0]!;
  expect(r.attribution).toEqual({
    session: pseudonym(SALT, '11111111-2222-3333-4444-555555555555'),
    agent: pseudonym(SALT, 'agent-abc'),
    parentAgent: pseudonym(SALT, 'agent-parent'),
    promptId: pseudonym(SALT, 'prompt-xyz'),
    requestClass: 'subagent',
    agentType: 'general-purpose',
    repo: 'shop',
    branch: 'feat/ABC-1',
    ticket: 'ABC-1',
    feature: 'checkout',
  });
  expect(r.client).toEqual({ agent: 'claude-code', version: '2.1.5' });
  const wire = JSON.stringify(r);
  for (const raw of ['11111111-2222', 'agent-abc', 'agent-parent', 'prompt-xyz']) expect(wire).not.toContain(raw);
});
