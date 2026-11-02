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

const MD_ENTITY: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '|': '&#124;',
  '`': '&#96;',
  '*': '&#42;',
  _: '&#95;',
  '[': '&#91;',
  ']': '&#93;',
  '~': '&#126;',
  '@': '&#64;',
  '#': '&#35;',
};

/**
 * A label for Markdown and HTML output (the PR comment): line breaks and tabs become spaces, other control characters
 * and line/paragraph separators are dropped, and every character that can start markup, a link, a mention, a table
 * cell break or HTML is written as a character reference. The result is plain text in any Markdown renderer and
 * cannot add a table column, a link or a tag. Cut to `max` characters before escaping.
 */
export function escapeMarkdown(s: string, max: number = 256): string {
  let out = '';
  for (const ch of s.slice(0, max)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x2028 || code === 0x2029) out += ' ';
    else if (isControl(code)) continue;
    else out += MD_ENTITY[ch] ?? ch;
  }
  return out;
}
