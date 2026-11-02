/** Shell text for `eval "$(tokenyard env)"` (spec 3, step 4): repo, branch and ticket headers for Claude Code. */

const DEFAULT_TICKET = '[A-Z][A-Z0-9]+-\\d+';

function ticketOf(branch: string, pattern: string | null): string | null {
  const m = new RegExp(pattern ?? DEFAULT_TICKET).exec(branch);
  return m ? (m[1] ?? m[0]) : null;
}

const OWN = /^x-tokenyard-(repo|branch|ticket)\s*:/i;
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** Headers already in `ANTHROPIC_CUSTOM_HEADERS` (`existing`) are kept; ours follow, one per line. */
export function buildEnvExport(o: { repo: string; branch: string; ticketPattern: string | null; existing: string | null }): string {
  // Idempotent: earlier repo, branch and ticket lines are replaced, everything else is kept.
  const lines = (o.existing ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !OWN.test(l));
  lines.push(`x-tokenyard-repo: ${oneLine(o.repo)}`, `x-tokenyard-branch: ${oneLine(o.branch)}`);
  const ticket = ticketOf(o.branch, o.ticketPattern);
  if (ticket) lines.push(`x-tokenyard-ticket: ${oneLine(ticket)}`);
  return `export ANTHROPIC_CUSTOM_HEADERS=${shellQuote(lines.join('\n'))}\n`;
}
