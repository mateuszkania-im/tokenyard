import { createHash } from 'node:crypto';
import type { Usage } from '../stream/anthropic-usage.js';

const TTL_5M = 5 * 60_000;
const TTL_1H = 60 * 60_000;
const LOOKBACK = 20;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The mock's own deterministic tokenizer: one token per four bytes. */
export const tokensForBytes = (bytes: number): number => Math.ceil(bytes / 4);

interface Unit {
  bytes: number;
  canonical: string;
  ttlMs: number | null;
}

function unit(value: Obj, extra?: Obj): Unit {
  const { cache_control: cc, ...rest } = value;
  const canonical = canon(extra ? { ...extra, block: rest } : rest);
  let ttlMs: number | null = null;
  if (isObj(cc)) ttlMs = cc.ttl === '1h' ? TTL_1H : TTL_5M;
  return { bytes: Buffer.byteLength(canonical), canonical, ttlMs };
}

/** Prefix units in cache order: tools, then system, then messages. cache_control does not change a unit's identity. */
export function prefixUnits(body: unknown): Unit[] {
  const b = isObj(body) ? body : {};
  const out: Unit[] = [];
  if (Array.isArray(b.tools)) for (const t of b.tools) out.push(unit(isObj(t) ? t : { value: t }, { part: 'tool' }));
  if (typeof b.system === 'string') out.push(unit({ text: b.system }, { part: 'system-string' }));
  else if (Array.isArray(b.system)) for (const s of b.system) out.push(unit(isObj(s) ? s : { value: s }, { part: 'system' }));
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (!isObj(m)) continue;
      const role = m.role;
      if (typeof m.content === 'string') out.push(unit({ text: m.content }, { part: 'message', role }));
      else if (Array.isArray(m.content)) {
        for (const c of m.content) out.push(unit(isObj(c) ? c : { value: c }, { part: 'message', role }));
      }
    }
  }
  return out;
}

export function countTokens(body: unknown): number {
  return tokensForBytes(prefixUnits(body).reduce((n, u) => n + u.bytes, 0));
}

function toObject(body: unknown): unknown {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

interface Entry {
  expiresAt: number;
  ttlMs: number;
  tokens: number;
}

/**
 * Deterministic prompt cache. A breakpoint is a block carrying cache_control; its key is the hash of
 * everything before and including it (tools, system, messages), per workspace and model.
 */
export class CacheSimulator {
  private entries = new Map<string, Entry>();
  private prunedAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly workspace = 'default') {}

  /** Drops expired entries at most once a minute, so a long-running mock keeps only live prefixes (V2). */
  private prune(nowMs: number): void {
    if (nowMs - this.prunedAt < 60_000) return;
    this.prunedAt = nowMs;
    for (const [k, e] of this.entries) if (e.expiresAt <= nowMs) this.entries.delete(k);
  }

  usageFor(body: unknown, model: string, nowMs: number): Usage {
    this.prune(nowMs);
    const units = prefixUnits(toObject(body));
    const h = createHash('sha256');
    let bytes = 0;
    const keys: string[] = [];
    const bpIdx: number[] = [];
    const bpTokens = new Map<number, number>();
    const bpTtl = new Map<number, number>();
    units.forEach((u, i) => {
      h.update(u.canonical);
      h.update('\n');
      bytes += u.bytes;
      keys.push(`${this.workspace}|${model}|${h.copy().digest('hex')}`);
      if (u.ttlMs !== null) {
        bpIdx.push(i);
        bpTokens.set(i, tokensForBytes(bytes));
        bpTtl.set(i, u.ttlMs);
      }
    });
    const total = tokensForBytes(bytes);
    // Like the real API, look back up to LOOKBACK blocks before each breakpoint for an existing entry.
    let hitUnit = -1;
    let cacheRead = 0;
    for (const b of bpIdx) {
      for (let j = b; j >= Math.max(0, b - LOOKBACK); j--) {
        if (j <= hitUnit) break;
        const e = this.entries.get(keys[j] as string);
        if (e && e.expiresAt > nowMs) {
          hitUnit = j;
          cacheRead = e.tokens;
          e.expiresAt = nowMs + e.ttlMs;
          break;
        }
      }
    }
    let w5 = 0;
    let w1 = 0;
    let prev = cacheRead;
    for (const b of bpIdx) {
      if (b <= hitUnit) continue;
      const tokens = bpTokens.get(b) as number;
      const ttlMs = bpTtl.get(b) as number;
      const delta = tokens - prev;
      if (delta <= 0) continue;
      if (ttlMs === TTL_1H) w1 += delta;
      else w5 += delta;
      prev = tokens;
      this.entries.set(keys[b] as string, { expiresAt: nowMs + ttlMs, ttlMs, tokens });
    }
    return { input: total - cacheRead - w5 - w1, output: 0, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1 };
  }
}
