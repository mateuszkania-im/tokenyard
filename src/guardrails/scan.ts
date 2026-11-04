// Secret scanner (spec 5.3 step 5, 6.6). Pure: runs before admit, needs no store, and returns only HMACs of what it
// found. Rules run on the decoded content of the JSON strings in the scanned byte range, not on the raw escaped bytes,
// so a secret after a `\n` or `\t` escape, one written with `\uXXXX` escapes and one split across two text blocks of
// a message are all seen as the model sees them. A map from decoded index to byte offset keeps redaction on exact bytes.
import type { GuardrailHit } from '../policy/types.js';
import { pseudonym } from './hmac.js';
import type { SecretRule } from './rules.js';

export type GuardrailAction = GuardrailHit['action'];
type Range = { start: number; end: number };
/** A byte range of a match; `bare` when it lies in a token outside quotes (redaction then writes a quoted placeholder). */
export type Segment = Range & { bare?: true };

/** One match: the rule, its byte range in the body, the decoded value (never leaves the process) and its byte pieces. */
export interface Span {
  rule: SecretRule;
  start: number;
  end: number;
  value: string;
  /** Byte ranges the value occupies, in order; more than one when it is split across strings (text blocks). */
  segments: Segment[];
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

// ---- Decoded views -------------------------------------------------------------------------------------------------
// The decoded text holds one character per UTF-8 byte (a latin1 view), so a raw byte and the same byte written as a
// `\u` escape decode alike. Strings are separated by SEP, which no rule matches across.
const SEP = '\0';
const PLAIN = 0;
const ESCAPE = 1;
const SEPARATOR = 2;
/** A token outside quotes (a number, a literal, a bare word in lenient or malformed JSON): mapped like PLAIN. */
const BARE = 3;
/** Shown between an object key and its value, so assignment-style rules read `key: value`. Zero bytes wide. */
const MEMBER = ': ';
/** Values of these keys are message text: inside one message they are joined without a separator. */
const PIECE_KEYS = new Set(['text', 'content', 'thinking']);
const SIMPLE_ESCAPES: Record<number, string> = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' };
/** The same escapes by byte: the code of the decoded character, or 0 for a byte that is not a simple escape. */
const SIMPLE_ESCAPE_CODE = new Uint8Array(256);
for (const [k, v] of Object.entries(SIMPLE_ESCAPES)) SIMPLE_ESCAPE_CODE[Number(k)] = v.charCodeAt(0);

// ---- Scan work budget (S-V3-3) ------------------------------------------------------------------------------------
// The scan's time and memory grow with the number of decoded runs (each string, token and escape is one or two) and
// with the number of regex matches (each gets its byte segments, a span and an HMAC), not with bytes alone: 32 MiB of
// `"a",` held the event loop for 2 to 6 s and 32 MiB of `1,` needed more than 2 GB before V8 gave up. Both are counted
// as they are made and the scan stops at the first one over its cap, before allocating it.

/**
 * Most decoded runs one scan call (`scanBody` over all its regions, or `findSpans`) may build, over all its views.
 * A run costs about 40 ns and 16 bytes plus its text. A body that passes the gateway's earlier budgets (1 Mi JSON
 * values, 1 Mi escapes) makes at most 2 runs per value and 2 per escape, plus the joined copies of split message text:
 * a message made of several pieces is scanned again as one joined view, which copies its runs, so such a body can make
 * twice as many runs and be refused here while inside the escape budget (7.1 MiB of multi-block tool results with
 * 947,000 escapes made 3.95 Mi runs). That needs far more than a 1 M token context window (about 4 MiB of text,
 * under 0.6 Mi runs); the bench's 31 MiB coding-agent body makes 1.8 Mi.
 */
export const SCAN_RUN_BUDGET = 3 * 1024 * 1024;
/**
 * Most regex matches one scan call may try, counted before the entropy and checksum checks. Each costs 1 to 3 us with
 * its segments, span and HMAC. Ordinary bodies match a handful (the false-positive corpus at most 108 per file); a
 * product prompt with 60,000 email addresses or long numbers still passes.
 */
export const SCAN_MATCH_BUDGET = 64 * 1024;

/** A scan stopped at its work budget (S-V3-3); the gateway answers 413 `scan-budget` and sends nothing. */
export class ScanBudgetError extends Error {
  constructor(
    readonly counter: 'runs' | 'matches',
    readonly limit: number,
  ) {
    super(`the secret scan stopped after ${limit} ${counter === 'runs' ? 'decoded string pieces' : 'rule matches'}`);
    this.name = 'ScanBudgetError';
  }
}

/** The work one scan call may still do: shared by every view and rule of that call. */
export class ScanBudget {
  private runsLeft: number;
  private matchesLeft: number;
  constructor(
    readonly runLimit: number = SCAN_RUN_BUDGET,
    readonly matchLimit: number = SCAN_MATCH_BUDGET,
  ) {
    this.runsLeft = runLimit;
    this.matchesLeft = matchLimit;
  }
  run(): void {
    if (--this.runsLeft < 0) throw new ScanBudgetError('runs', this.runLimit);
  }
  match(): void {
    if (--this.matchesLeft < 0) throw new ScanBudgetError('matches', this.matchLimit);
  }
  /** Work done so far (tests and benchmarks show how far ordinary bodies stay below the caps). */
  used(): { runs: number; matches: number } {
    return { runs: this.runLimit - this.runsLeft, matches: this.matchLimit - this.matchesLeft };
  }
}

/**
 * One decoded view: its text as latin1 bytes in a growing buffer and, per run, where it sits in the text and the body.
 * No string per run (S-V3-3: a string and five array slots per run were about 100 bytes; this is 16 per run plus the
 * text), and runs are counted against the scan budget before they are stored.
 */
class View {
  private buf: Buffer = Buffer.allocUnsafe(256);
  /** Stride 4: text start, byte start, byte end, kind. */
  private runs: Uint32Array = new Uint32Array(64);
  private count = 0;
  length = 0;
  private textCache: string | null = null;

  constructor(private readonly budget: ScanBudget) {}

  /** Room for one more run of `chars` characters; counts the run against the budget first. */
  private open(chars: number, bStart: number, bEnd: number, kind: number): number {
    this.budget.run();
    if ((this.count + 1) * 4 > this.runs.length) {
      const next = new Uint32Array(this.runs.length * 2);
      next.set(this.runs);
      this.runs = next;
    }
    if (this.length + chars > this.buf.length) {
      const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.length + chars));
      this.buf.copy(next, 0, 0, this.length);
      this.buf = next;
    }
    const r = this.count * 4;
    this.runs[r] = this.length;
    this.runs[r + 1] = bStart;
    this.runs[r + 2] = bEnd;
    this.runs[r + 3] = kind;
    this.count++;
    this.textCache = null;
    const at = this.length;
    this.length += chars;
    return at;
  }

  /** A run of decoded text (latin1: one character per byte). */
  push(text: string, bStart: number, bEnd: number, kind: number): void {
    if (text.length === 0) return;
    const at = this.open(text.length, bStart, bEnd, kind);
    for (let k = 0; k < text.length; k++) this.buf[at + k] = text.charCodeAt(k);
  }

  /** A run of one decoded character below 0x80 (a simple escape such as `\n`), without a string for it (0.2.1). */
  pushByte(code: number, bStart: number, bEnd: number, kind: number): void {
    const at = this.open(1, bStart, bEnd, kind);
    this.buf[at] = code;
  }

  /** A run whose text is the body's own bytes `[bStart, bEnd)`. */
  pushBytes(body: Buffer, bStart: number, bEnd: number, kind: number): void {
    if (bEnd <= bStart) return;
    const at = this.open(bEnd - bStart, bStart, bEnd, kind);
    body.copy(this.buf, at, bStart, bEnd);
  }

  runCount(): number {
    return this.count;
  }

  private textStart(k: number): number {
    return k < this.count ? (this.runs[k * 4] as number) : this.length;
  }

  /** Decoded text of runs `[from, to)`. */
  textOf(from: number, to: number): string {
    return this.buf.toString('latin1', this.textStart(from), this.textStart(to));
  }

  copyRuns(from: number, to: number, into: View): void {
    for (let k = from; k < to; k++) {
      const t = this.textStart(k);
      const tEnd = this.textStart(k + 1);
      const at = into.open(tEnd - t, this.runs[k * 4 + 1] as number, this.runs[k * 4 + 2] as number, this.runs[k * 4 + 3] as number);
      this.buf.copy(into.buf, at, t, tEnd);
    }
  }

  separate(at: number, text: string = SEP): void {
    if (this.length > 0) this.push(text, at, at, SEPARATOR);
  }

  get text(): string {
    this.textCache ??= this.buf.toString('latin1', 0, this.length);
    return this.textCache;
  }

  /** Byte ranges of decoded `[s, e)`; a separator or a gap between strings starts a new range. */
  segments(s: number, e: number): Segment[] {
    const r = this.runs;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((r[mid * 4] as number) <= s) lo = mid;
      else hi = mid - 1;
    }
    const out: Segment[] = [];
    for (let k = lo; k < this.count; k++) {
      const t = r[k * 4] as number;
      if (t >= e) break;
      const b = r[k * 4 + 1] as number;
      const bEnd = r[k * 4 + 2] as number;
      const kind = r[k * 4 + 3] as number;
      const tl = this.textStart(k + 1) - t;
      if (kind === SEPARATOR) continue;
      const linear = kind === PLAIN || kind === BARE;
      const from = linear ? b + Math.max(s, t) - t : b;
      const to = linear ? b + Math.min(e, t + tl) - t : bEnd;
      const last = out[out.length - 1];
      if (last !== undefined && last.end === from && (last.bare === true) === (kind === BARE)) last.end = to;
      else out.push(kind === BARE ? { start: from, end: to, bare: true } : { start: from, end: to });
    }
    return out;
  }
}

/** UTF-8 bytes of a code point as latin1 characters, computed (V3: one Buffer per `\u` escape cost more than the scan). */
function utf8Latin1(cp: number): string {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

function hex4(b: Buffer, i: number): number {
  if (i + 4 > b.length) return -1;
  const s = b.toString('latin1', i, i + 4);
  return /^[0-9A-Fa-f]{4}$/.test(s) ? Number.parseInt(s, 16) : -1;
}

/** One escape at `e` (a backslash): its decoded text and the index just past it. */
function decodeEscape(b: Buffer, e: number, end: number): { text: string; next: number } {
  const c = b[e + 1];
  if (c === undefined || e + 1 >= end) return { text: '\\', next: Math.min(e + 1, end) };
  const simple = SIMPLE_ESCAPES[c];
  if (simple !== undefined) return { text: simple, next: e + 2 };
  if (c !== 0x75) return { text: b.toString('latin1', e, e + 2), next: e + 2 };
  const u = hex4(b, e + 2);
  if (u < 0 || e + 6 > end) return { text: b.toString('latin1', e, e + 2), next: e + 2 };
  if (u >= 0xd800 && u <= 0xdbff && b[e + 6] === 0x5c && b[e + 7] === 0x75 && e + 12 <= end) {
    const lo = hex4(b, e + 8);
    if (lo >= 0xdc00 && lo <= 0xdfff) return { text: utf8Latin1(0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00)), next: e + 12 };
  }
  return { text: utf8Latin1(u >= 0xd800 && u <= 0xdfff ? 0xfffd : u), next: e + 6 };
}

const isWs = (c: number | undefined): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Decoded views of the JSON strings in `body[start, end)` (a range that starts and ends outside any string):
 * `all` holds every string, separated; `joined` holds the message-text values (`text`, `content`, `thinking`) of each
 * message in `messages` joined with no separator, messages separated, so a value split across text blocks is whole.
 */
const isStructural = (c: number | undefined): boolean => c === 0x7b || c === 0x7d || c === 0x5b || c === 0x5d || c === 0x2c || c === 0x3a;

/**
 * A body JSON.parse refused (or one with duplicate keys a provider may read differently): no structure to trust, so
 * the raw bytes are scanned as they are, and a best-effort decoded copy beside them (escapes undone anywhere, invalid
 * ones kept literal), so an escaped secret is not missed either. Fail toward detection.
 */
function rawViews(body: Buffer, start: number, end: number, budget: ScanBudget): { all: View; joined: View | null; decoded: View } {
  const all = new View(budget);
  all.pushBytes(body, start, end, PLAIN);
  const decoded = new View(budget);
  let p = start;
  while (p < end) {
    const esc = body.indexOf(0x5c, p);
    const stop = esc < 0 || esc >= end ? end : esc;
    if (stop > p) decoded.pushBytes(body, p, stop, PLAIN);
    if (stop >= end) break;
    const d = decodeEscape(body, stop, end);
    decoded.push(d.text, stop, d.next, ESCAPE);
    p = Math.max(d.next, stop + 1);
  }
  return { all, joined: null, decoded };
}

function buildViews(body: Buffer, start: number, end: number, messages: readonly Range[] | undefined, raw: boolean, budget: ScanBudget): { all: View; joined: View | null; decoded?: View } {
  if (raw) return rawViews(body, start, end, budget);
  const all = new View(budget);
  const joined = messages && messages.length > 0 ? new View(budget) : null;
  let lastKey: string | null = null;
  let group = -1;
  let pending: { first: number; last: number; at: number } | null = null;
  let m = 0;
  /** The previous item was an object key: the next value is shown as `key: value`. */
  let member = false;
  /** The last structural byte seen was a colon (the next string or token is a member value). */
  let afterColon = false;
  // Next backslash and next quote at or after the cursor, cached so each is searched for once per occurrence (linear).
  let bs = -2;
  let nq = -2;
  const nextBs = (p: number): number => (bs !== -1 && bs < p ? (bs = body.indexOf(0x5c, p)) : bs);
  const nextQuote = (p: number): number => {
    if (nq !== -1 && nq < p) nq = body.indexOf(0x22, p);
    return nq < 0 || nq >= end ? end : nq;
  };
  const opening = (at: number): void => {
    if (member) all.separate(at, MEMBER);
    else all.separate(at);
    member = false;
  };
  let i = start;
  while (i < end) {
    const q = nextQuote(i);
    // Bytes outside quotes: structure, whitespace, and tokens (numbers, literals, bare words), kept as BARE runs.
    while (i < q) {
      const c = body[i];
      if (isWs(c)) {
        i++;
      } else if (isStructural(c)) {
        afterColon = c === 0x3a;
        if (c !== 0x3a) member = false;
        i++;
      } else {
        let j = i + 1;
        while (j < q && !isWs(body[j]) && !isStructural(body[j])) j++;
        opening(i);
        all.pushBytes(body, i, j, BARE);
        afterColon = false;
        i = j;
      }
    }
    if (q >= end) break;
    const valueOfMember = afterColon;
    afterColon = false;
    opening(q);
    const first = all.runCount();
    let p = q + 1;
    let close: number;
    for (;;) {
      const quote = nextQuote(p);
      const esc = nextBs(p);
      if (esc >= 0 && esc < quote) {
        if (esc > p) all.pushBytes(body, p, esc, PLAIN);
        // A simple escape (`\n`, `\"`, `\\`, ...), most of them in source code: as decodeEscape decodes it.
        const simple = esc + 1 < end ? (SIMPLE_ESCAPE_CODE[body[esc + 1] as number] as number) : 0;
        if (simple !== 0) {
          all.pushByte(simple, esc, esc + 2, ESCAPE);
          p = esc + 2;
          continue;
        }
        const d = decodeEscape(body, esc, end);
        all.push(d.text, esc, d.next, ESCAPE);
        p = d.next;
        continue;
      }
      if (quote > p) all.pushBytes(body, p, quote, PLAIN);
      close = quote;
      break;
    }
    const last = all.runCount();
    let k = close + 1;
    while (k < end && isWs(body[k])) k++;
    if (k < end && body[k] === 0x3a) {
      lastKey = all.textOf(first, last);
      member = true;
    } else if (joined && messages && valueOfMember && lastKey !== null && PIECE_KEYS.has(lastKey)) {
      while (m < messages.length && (messages[m] as Range).end <= q) m++;
      const msg = messages[m];
      if (msg !== undefined && q >= msg.start) {
        // A message's first piece waits until a second one arrives: a message with one piece has nothing to join, and
        // `joined` only reports matches that cross pieces, which no message with one piece can hold (V1).
        if (m !== group) {
          group = m;
          pending = { first, last, at: q };
        } else {
          if (pending !== null) {
            joined.separate(pending.at);
            all.copyRuns(pending.first, pending.last, joined);
            pending = null;
          }
          all.copyRuns(first, last, joined);
        }
      }
    }
    i = close + 1;
  }
  return { all, joined: joined && joined.length > 0 ? joined : null };
}

const keywordRegex = new Map<string, RegExp>();
/** One alternation of the literal keywords, longest first, compiled once per keyword list. */
function keywordAlternation(keywords: readonly string[]): RegExp {
  // JSON, not a join: ['b', 'A'] and ['b\0A'] joined with NUL are one text and were given one alternation.
  const id = JSON.stringify(keywords);
  let re = keywordRegex.get(id);
  if (re === undefined) {
    if (keywordRegex.size >= 64) keywordRegex.clear(); // a handful of rule lists exist; never grows without bound
    const sorted = [...keywords].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    re = new RegExp(sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('|'), 'g');
    keywordRegex.set(id, re);
  }
  return re;
}

/**
 * The keywords that occur in `text`, as `keywords.filter((k) => text.includes(k))` would find them, in one pass
 * (V1: about 40 `includes` calls over a 150 KB view cost more than every regex the prefilter then lets through).
 * Every start position is tried; where two keywords start at the same position the longer is reported, so the
 * keywords that are a prefix of a found one are added after the pass.
 */
export function keywordsIn(text: string, keywords: readonly string[]): Set<string> {
  const found = new Set<string>();
  // An empty keyword occurs in every text, as `''.includes` says: its rule always runs.
  if (keywords.includes('')) found.add('');
  const list = keywords.filter((k) => k.length > 0);
  if (list.length === 0) return found;
  // A found keyword leaves the alternation, so the pass stops at one hit per keyword (S-V3-3: 32 MiB of `@` were 32 Mi
  // hits of one keyword, 0.85 s); at most one alternation per keyword is compiled.
  let left = list;
  let from = 0;
  while (left.length > 0) {
    const re = keywordAlternation(left);
    re.lastIndex = from;
    const m = re.exec(text);
    if (m === null) break;
    const hit = m[0];
    found.add(hit);
    from = m.index + 1;
    left = left.filter((k) => k !== hit);
  }
  for (const k of list) if (!found.has(k) && [...found].some((f) => f.startsWith(k))) found.add(k);
  return found;
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

/** Matches of `rule` in one view; from the joined view only those that cross strings (the rest come from `all`). */
const isDelimiter = (c: number | undefined): boolean => c === undefined || isWs(c) || isStructural(c);

/** A numeric PII match in a bare token: kept only when it is the whole token, an unsigned integer the rule accepts. */
function bareNumberOk(body: Buffer, rule: SecretRule, value: string, segments: Segment[], quotedOnly: boolean): boolean {
  if (quotedOnly || !rule.bareNumber || segments.length !== 1 || !/^\d+$/.test(value)) return false;
  const g = segments[0] as Segment;
  return isDelimiter(g.start > 0 ? body[g.start - 1] : undefined) && isDelimiter(body[g.end]) && rule.bareNumber(value);
}

function matchView(view: View, rule: SecretRule, crossingOnly: boolean, out: Span[], body: Buffer, quotedOnly: boolean, present: ReadonlySet<string>, budget: ScanBudget): void {
  if (rule.keywords.length > 0 && !rule.keywords.some((k) => present.has(k))) return;
  const text = view.text;
  const re = globalOf(rule);
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    budget.match();
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const value = m[1] ?? m[0];
    const offset = m[1] === undefined ? 0 : m[0].indexOf(m[1]);
    if (rule.minEntropy !== undefined && shannonEntropy(value) < rule.minEntropy) continue;
    if (rule.validate && !rule.validate(value)) continue;
    const s = m.index + offset;
    const segments = view.segments(s, s + value.length);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (first === undefined || last === undefined || (crossingOnly && segments.length < 2)) continue;
    if (rule.bareNumber && segments.some((g) => g.bare) && !bareNumberOk(body, rule, value, segments, quotedOnly)) continue;
    out.push({ rule, start: first.start, end: last.end, value, segments });
  }
}

/**
 * Most JSON escapes a body may hold (S-V3-1; the handler counts the whole body, which the scanner decodes whole
 * whenever a rule blocks, on product routes and for bodies it cannot trust). Each escape is decoded on its own, so
 * 32 MiB of escapes held the event loop for 1.0 to 2.9 s. JSON-encoded source code holds one escape per 16 to 30 bytes,
 * so a body may hold 16 to 30 MiB of it, far more than any model's context window. The scan's other cost drivers
 * (runs, matches) have their own budgets above (S-V3-3).
 */
export const SCAN_ESCAPE_BUDGET = 1024 * 1024;

/** Backslash escapes in `body[range)`, counted up to `max + 1` and no further; an escaped backslash counts once. */
export function countEscapesUpTo(body: Buffer, range: Range, max: number): number {
  let n = 0;
  let p = range.start;
  while (n <= max) {
    const e = body.indexOf(0x5c, p);
    if (e < 0 || e >= range.end) break;
    n++;
    p = e + 2;
  }
  return n;
}

/**
 * Every match of `rules` in the decoded strings of `body[range)` (the whole body by default), in rule order then
 * position. The keyword prefilter runs on the decoded text before any regex; entropy and `validate` run on the value.
 * With `messages`, text values split across blocks of one message are matched whole too.
 */
export function findSpans(body: Buffer, rules: readonly SecretRule[], opts: { range?: Range; messages?: readonly Range[]; raw?: boolean; quotedOnly?: boolean; budget?: ScanBudget } = {}): Span[] {
  const q = opts.quotedOnly === true;
  const range = opts.range ?? { start: 0, end: body.length };
  const out: Span[] = [];
  if (rules.length === 0 || range.end <= range.start) return out;
  const budget = opts.budget ?? new ScanBudget();
  const { all, joined, decoded } = buildViews(body, range.start, range.end, opts.messages, opts.raw === true, budget);
  const keywords = [...new Set(rules.flatMap((r) => r.keywords))];
  const lazy = (v: View): (() => ReadonlySet<string>) => {
    let set: Set<string> | null = null;
    return () => (set ??= keywordsIn(v.text, keywords));
  };
  const inAll = lazy(all);
  const inJoined = joined ? lazy(joined) : null;
  const inDecoded = decoded ? lazy(decoded) : null;
  for (const rule of rules) {
    const start = out.length;
    matchView(all, rule, false, out, body, q, inAll(), budget);
    if (joined && inJoined) matchView(joined, rule, true, out, body, q, inJoined(), budget);
    // The decoded copy of a raw body: a value it shares with the raw view is reported once (same rule and bytes).
    if (decoded && inDecoded) {
      const before = out.length;
      const known = new Set(out.slice(start).map((r) => `${r.start}:${r.end}`));
      matchView(decoded, rule, false, out, body, q, inDecoded(), budget);
      const fresh = out.splice(before).filter((d) => !known.has(`${d.start}:${d.end}`));
      out.push(...fresh);
    }
  }
  return out;
}

/** Index of the message whose byte range holds `pos`, if any: a binary search, as message ranges are in body order. */
function messageAt(messages: readonly Range[] | undefined, pos: number): number | undefined {
  if (!messages || messages.length === 0) return undefined;
  let lo = 0;
  let hi = messages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((messages[mid] as Range).start <= pos) lo = mid;
    else hi = mid - 1;
  }
  const m = messages[lo] as Range;
  return pos >= m.start && pos < m.end ? lo : undefined;
}

/**
 * Spec 6.6: the newest turn (`lastTurn`) with every rule, the rest of the body with the rules whose action is not
 * `warn` (on coding-agent routes: the block rules). Entropy-only rules are `warn` at most, so they never block and are
 * not scanned in history. Each value is reported once per rule and place, as an HMAC with `salt` of its decoded form
 * (so the same secret escaped another way matches the taint), with the index of its message when `messages` are
 * given. No last turn: the whole body is history. `raw` (a body JSON.parse refused) scans the raw bytes instead of
 * decoded strings. `valueHmac: false` (PII rules, B8) reports no value HMAC (an empty string) and one hit per rule and place.
 */
export function scanBody(
  body: Buffer,
  lastTurn: Range | null,
  rules: readonly SecretRule[],
  actionFor: (rule: SecretRule) => GuardrailAction,
  salt: string,
  opts: { messages?: readonly Range[]; raw?: boolean; quotedOnly?: boolean; valueHmac?: boolean; budget?: ScanBudget } = {},
): GuardrailHit[] {
  const action = (r: SecretRule): GuardrailAction => (r.entropyOnly ? 'warn' : actionFor(r));
  const historyRules = rules.filter((r) => action(r) !== 'warn');
  const regions: Array<{ where: GuardrailHit['where']; range: Range; rules: readonly SecretRule[]; messages: readonly Range[] | undefined }> = lastTurn
    ? [
        { where: 'last-turn', range: lastTurn, rules, messages: opts.messages ?? [lastTurn] },
        { where: 'history', range: { start: 0, end: lastTurn.start }, rules: historyRules, messages: opts.messages },
        { where: 'history', range: { start: lastTurn.end, end: body.length }, rules: historyRules, messages: opts.messages },
      ]
    : [{ where: 'history', range: { start: 0, end: body.length }, rules: historyRules, messages: opts.messages }];
  const hits: GuardrailHit[] = [];
  const seen = new Set<string>();
  // One budget for every region: together they cover the body once.
  const budget = opts.budget ?? new ScanBudget();
  for (const region of regions) {
    for (const s of findSpans(body, region.rules, { range: region.range, raw: opts.raw === true, quotedOnly: opts.quotedOnly === true, budget, ...(region.messages ? { messages: region.messages } : {}) })) {
      const valueHmac = opts.valueHmac === false ? '' : pseudonym(salt, s.value);
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
