import type { IncomingHttpHeaders } from 'node:http';
import type { Surface } from '../policy/types.js';
import { sanitizeHeaderValue } from '../report/sanitize.js';

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
  /** True when a header value was cut or had characters dropped by `sanitizeHeaderValue`. Absent otherwise. */
  sanitized?: true;
}

function header(h: IncomingHttpHeaders, name: string, flag: { changed: boolean }): string | null {
  const v = h[name];
  const raw = (Array.isArray(v) ? v[0] : v)?.trim();
  if (!raw) return null;
  // Values come from the client and reach reports and PR comments: printable ASCII, at most 128 characters.
  const { value, changed } = sanitizeHeaderValue(raw);
  if (changed) flag.changed = true;
  return value === '' ? null : value;
}

/**
 * Claude Code sends `x-claude-code-*`; `eval "$(tokenyard env)"` adds `x-tokenyard-repo`, `-branch` and `-ticket`.
 * Codex has no official list: `session_id` or `session-id` is read as the session, best effort (spec 5.4).
 */
export function readAttribution(h: IncomingHttpHeaders, surface: Surface): RawAttribution {
  const f = { changed: false };
  const read = (name: string): string | null => header(h, name, f);
  const codex = surface === 'openai-responses' || surface === 'openai-chat';
  return {
    session: codex ? (read('session_id') ?? read('session-id')) : read('x-claude-code-session-id'),
    agent: read('x-claude-code-agent-id'),
    parentAgent: read('x-claude-code-parent-agent-id'),
    requestClass: read('x-claude-code-request-class'),
    agentType: read('x-claude-code-agent-type'),
    promptId: read('x-claude-code-prompt-id'),
    repo: read('x-tokenyard-repo'),
    branch: read('x-tokenyard-branch'),
    ticket: read('x-tokenyard-ticket'),
    feature: read('x-tokenyard-feature'),
    ...(f.changed ? { sanitized: true as const } : {}),
  };
}
