import { expect, test } from 'vitest';
import { readAttribution } from '../../src/edge/attribution.js';

const none = { session: null, agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null };

test('attribution: x-claude-code-* headers and x-tokenyard-repo/branch/ticket parsed', () => {
  const a = readAttribution(
    {
      'x-claude-code-session-id': 's1',
      'x-claude-code-agent-id': 'a1',
      'x-claude-code-parent-agent-id': 'a0',
      'x-claude-code-request-class': 'subagent',
      'x-claude-code-agent-type': 'general-purpose',
      'x-claude-code-prompt-id': 'p1',
      'x-tokenyard-repo': 'acme/web',
      'x-tokenyard-branch': 'feature/WEB-12-x',
      'x-tokenyard-ticket': 'WEB-12',
      'x-tokenyard-feature': 'checkout',
    },
    'anthropic-messages',
  );
  expect(a).toEqual({ session: 's1', agent: 'a1', parentAgent: 'a0', requestClass: 'subagent', agentType: 'general-purpose', promptId: 'p1', repo: 'acme/web', branch: 'feature/WEB-12-x', ticket: 'WEB-12', feature: 'checkout' });
});

test('attribution: absent, empty and repeated headers', () => {
  expect(readAttribution({}, 'anthropic-messages')).toEqual(none);
  expect(readAttribution({ 'x-claude-code-session-id': '  ', 'x-tokenyard-repo': ['r1', 'r2'] }, 'anthropic-count-tokens')).toEqual({ ...none, repo: 'r1' });
});

test('attribution: codex session_id and session-id on the OpenAI surfaces', () => {
  expect(readAttribution({ session_id: 'c1' }, 'openai-responses').session).toBe('c1');
  expect(readAttribution({ 'session-id': 'c2' }, 'openai-chat').session).toBe('c2');
  expect(readAttribution({ session_id: 'c1', 'session-id': 'c2' }, 'openai-responses').session).toBe('c1');
  expect(readAttribution({ session_id: 'c1' }, 'anthropic-messages').session).toBeNull();
});
