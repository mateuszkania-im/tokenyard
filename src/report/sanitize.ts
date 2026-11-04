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

const ZERO_WIDTH_SPACE = '\u200b';
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
  // GitHub still resolves @name and #1 written as character references, so these two get a zero-width space instead.
  '@': `@${ZERO_WIDTH_SPACE}`,
  '#': `#${ZERO_WIDTH_SPACE}`,
  // GitHub decodes character references before its emoji, autolink and cross-reference filters, so entities alone do not
  // stop :smile:, https:// or www.; ':' gets a zero-width space, '.' stays an entity, '\\' cannot escape what follows it.
  ':': `:${ZERO_WIDTH_SPACE}`,
  '.': '&#46;',
  '\\': '&#92;',
  // $...$ renders as math on GitHub, also with a zero-width space or entity inside and with \\$; the fullwidth dollar sign does not.
  $: '\uff04',
};

/**
 * A label for Markdown and HTML output (the PR comment): line breaks and tabs become spaces, other control characters
 * and line/paragraph separators are dropped, and what can start markup is neutralised: HTML and table characters as
 * character references; '@', '#' and ':' followed by a zero-width space (mentions, issue and team references, emoji codes, https://
 * autolinks) and '$' as the fullwidth dollar sign U+FF04 (math); a zero-width space between a letter run and '-digit' (GH-1 cross-references); and a
 * zero-width space after every sixth character of a hex run of 7 or more (commit SHAs and their prefixes). Checked
 * against GitHub's own renderer (`gh api markdown`, gfm mode): the result is plain text, with no new table column,
 * link, tag, mention or cross-reference. Cut to `max` characters before escaping.
 */
export function escapeMarkdown(s: string, max: number = 256): string {
  let out = '';
  for (const ch of s.slice(0, max)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x2028 || code === 0x2029) out += ' ';
    else if (isControl(code)) continue;
    else out += MD_ENTITY[ch] ?? ch;
  }
  return out
    .replace(/[0-9a-fA-F]{7,}/g, (run) => run.match(/.{1,6}/g)?.join(ZERO_WIDTH_SPACE) ?? run)
    .replace(/([A-Za-z])-(?=\d)/g, `$1-${ZERO_WIDTH_SPACE}`);
}
