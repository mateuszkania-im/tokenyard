// Pure helpers for labels that come from client headers (repo, branch, ticket, request class ...) and reach renderers.

const isControl = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/** Removes C0 (including ESC, CR, LF, TAB), DEL and C1 control characters. Terminal renderers run every label through this. */
export function stripControls(s: string): string {
  let out = '';
  for (const ch of s) if (!isControl(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

export const MAX_LABEL_LENGTH = 128;

/**
 * Ingest sanitiser for attribution header values: keeps printable ASCII (0x20 to 0x7E) only, drops everything else
 * (control characters, non-ASCII) and cuts to `max` characters. `changed` says whether anything was dropped or cut.
 */
export function sanitizeHeaderValue(s: string, max: number = MAX_LABEL_LENGTH): { value: string; changed: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) out += s[i];
  }
  const value = out.slice(0, max);
  return { value, changed: value !== s };
}
