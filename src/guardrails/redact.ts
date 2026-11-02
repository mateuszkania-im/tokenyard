// Product-route redaction (spec 6.6): matched values become `[REDACTED:<RULE>_<n>]`, every other byte is kept. Never
// used on coding-agent routes, whose bodies are forwarded unchanged. Pure.

/** `[REDACTED:<RULE>_<n>]`: the rule id upper-cased with `-` as `_`; `n` counts distinct values per rule from 1. */
const placeholder = (rule: string, n: number): string => `[REDACTED:${rule.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${n}]`;

/**
 * The body with each hit's byte range replaced by its placeholder. The same value under the same rule gets the same
 * number. Overlapping ranges keep the one that starts first. With no hits the same Buffer comes back.
 * The placeholder holds no quote or backslash, so a range inside a JSON string stays a valid JSON string.
 */
export function redactProductBody(body: Buffer, hits: Array<{ rule: string; start: number; end: number }>): Buffer {
  if (hits.length === 0) return body;
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const numbers = new Map<string, Map<string, number>>();
  const parts: Buffer[] = [];
  let at = 0;
  for (const h of sorted) {
    if (h.start < at || h.end <= h.start || h.end > body.length) continue;
    const value = body.toString('latin1', h.start, h.end);
    let perRule = numbers.get(h.rule);
    if (perRule === undefined) {
      perRule = new Map();
      numbers.set(h.rule, perRule);
    }
    let n = perRule.get(value);
    if (n === undefined) {
      n = perRule.size + 1;
      perRule.set(value, n);
    }
    parts.push(body.subarray(at, h.start), Buffer.from(placeholder(h.rule, n), 'latin1'));
    at = h.end;
  }
  parts.push(body.subarray(at));
  return Buffer.concat(parts);
}
