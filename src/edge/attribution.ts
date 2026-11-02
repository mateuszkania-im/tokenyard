import type { IncomingHttpHeaders } from 'node:http';
import type { Surface } from '../policy/types.js';

/** Attribution as sent by the client, before pseudonymisation (spec 9.1 HMACs session, agent, parentAgent and promptId). */
export interface RawAttribution {
  session: string | null;
  agent: string | null;
  parentAgent: string | null;
  requestClass: string | null;
  agentType: string | null;
  promptId: string | null;
  repo: string | null;
  branch: string | null;
  ticket: string | null;
  feature: string | null;
}

function header(h: IncomingHttpHeaders, name: string): string | null {
  const v = h[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : null;
}

/**
 * Claude Code sends `x-claude-code-*`; `eval "$(tokenyard env)"` adds `x-tokenyard-repo`, `-branch` and `-ticket`.
 * Codex has no official list: `session_id` or `session-id` is read as the session, best effort (spec 5.4).
 */
export function readAttribution(h: IncomingHttpHeaders, surface: Surface): RawAttribution {
  const codex = surface === 'openai-responses' || surface === 'openai-chat';
  return {
    session: codex ? (header(h, 'session_id') ?? header(h, 'session-id')) : header(h, 'x-claude-code-session-id'),
    agent: header(h, 'x-claude-code-agent-id'),
    parentAgent: header(h, 'x-claude-code-parent-agent-id'),
    requestClass: header(h, 'x-claude-code-request-class'),
    agentType: header(h, 'x-claude-code-agent-type'),
    promptId: header(h, 'x-claude-code-prompt-id'),
    repo: header(h, 'x-tokenyard-repo'),
    branch: header(h, 'x-tokenyard-branch'),
    ticket: header(h, 'x-tokenyard-ticket'),
    feature: header(h, 'x-tokenyard-feature'),
  };
}
