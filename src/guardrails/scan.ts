// Secret scanner (spec 5.3 step 5, 6.6). Pure: runs before admit, needs no store, and returns only HMACs of what it
// found. The body is scanned as bytes: rules match ASCII, so a latin1 view keeps every string index equal to its byte
// offset, which redaction needs.
import type { GuardrailHit } from '../policy/types.js';
import { pseudonym } from './hmac.js';
import type { SecretRule } from './rules.js';

export type GuardrailAction = GuardrailHit['action'];

/** One match: the rule, its byte range in the body and the matched value (never leaves the process). */
export interface Span {
  rule: SecretRule;
  start: number;
  end: number;
  value: string;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const globalRegex = new WeakMap<SecretRule, RegExp>();
function globalOf(rule: SecretRule): RegExp {
  let re = globalRegex.get(rule);
  if (re === undefined) {
    re = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`);
    globalRegex.set(rule, re);
  }
  return re;
}

/** Whether any keyword of `rule` occurs in `body[start, end)`: one `Buffer.indexOf` per keyword. */
function keywordIn(body: Buffer, rule: SecretRule, start: number, end: number): boolean {
  if (rule.keywords.length === 0) return true;
  return rule.keywords.some((k) => {
    const at = body.indexOf(k, start, 'latin1');
    return at >= 0 && at + k.length <= end;
  });
}

/**
 * Every match of `rules` inside `body[start, end)` (the whole body by default), in rule order then position.
 * The keyword prefilter runs before any regex; entropy and `validate` checks run on the value.
 */
export function findSpans(body: Buffer, rules: readonly SecretRule[], range: { start: number; end: number } = { start: 0, end: body.length }, text?: string): Span[] {
  const out: Span[] = [];
  let view = text;
  for (const rule of rules) {
    if (!keywordIn(body, rule, range.start, range.end)) continue;
    view ??= body.toString('latin1');
    const slice = view.slice(range.start, range.end);
    const re = globalOf(rule);
    re.lastIndex = 0;
    for (let m = re.exec(slice); m !== null; m = re.exec(slice)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const value = m[1] ?? m[0];
      const offset = m[1] === undefined ? 0 : m[0].indexOf(m[1]);
      if (rule.minEntropy !== undefined && shannonEntropy(value) < rule.minEntropy) continue;
      if (rule.validate && !rule.validate(value)) continue;
      const start = range.start + m.index + offset;
      out.push({ rule, start, end: start + value.length, value });
    }
  }
  return out;
}

/** Index of the message whose byte range holds `pos`, if any. */
function messageAt(messages: ReadonlyArray<{ start: number; end: number }> | undefined, pos: number): number | undefined {
  if (!messages) return undefined;
  const i = messages.findIndex((m) => pos >= m.start && pos < m.end);
  return i < 0 ? undefined : i;
}

/**
 * Spec 6.6: the newest turn (`lastTurn`) with every rule, the rest of the body with the rules whose action is not
 * `warn` (on coding-agent routes: the block rules). Entropy-only rules are `warn` at most, so they never block and are
 * not scanned in history. Each value is reported once per rule and place, as an HMAC with `salt`, with the index of
 * the message it is in when `messages` are given. No last turn: the whole body is history.
 */
export function scanBody(
  body: Buffer,
  lastTurn: { start: number; end: number } | null,
  rules: readonly SecretRule[],
  actionFor: (rule: SecretRule) => GuardrailAction,
  salt: string,
  opts: { messages?: ReadonlyArray<{ start: number; end: number }> } = {},
): GuardrailHit[] {
  const action = (r: SecretRule): GuardrailAction => (r.entropyOnly ? 'warn' : actionFor(r));
  const historyRules = rules.filter((r) => action(r) !== 'warn');
  const text = body.toString('latin1');
  const regions: Array<{ where: GuardrailHit['where']; start: number; end: number; rules: readonly SecretRule[] }> = lastTurn
    ? [
        { where: 'last-turn', start: lastTurn.start, end: lastTurn.end, rules },
        { where: 'history', start: 0, end: lastTurn.start, rules: historyRules },
        { where: 'history', start: lastTurn.end, end: body.length, rules: historyRules },
      ]
    : [{ where: 'history', start: 0, end: body.length, rules: historyRules }];
  const hits: GuardrailHit[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    if (region.end <= region.start || region.rules.length === 0) continue;
    for (const s of findSpans(body, region.rules, region, text)) {
      const valueHmac = pseudonym(salt, s.value);
      const id = `${s.rule.id}\0${valueHmac}\0${region.where}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const message = messageAt(opts.messages, s.start);
      hits.push({ rule: s.rule.id, action: action(s.rule), valueHmac, where: region.where, ...(message === undefined ? {} : { message }) });
    }
  }
  // Rule order first, so the order of hits does not depend on where the values sit.
  const order = new Map(rules.map((r, i) => [r.id, i]));
  return hits.sort((a, b) => (order.get(a.rule) ?? 0) - (order.get(b.rule) ?? 0));
}
