// Policy bundles (spec 6.7): one JSON document with a manifest, the policy, the price table and the keys. Pure: no I/O.
import { createHash } from 'node:crypto';
import { parsePriceTable, type PriceTable } from '../pricing/prices.js';
import { PolicyLoadError, type PolicySource } from './load-dir.js';
import { keysFileSchema, policySchema, type PolicyDoc } from './schema.js';
import type { KeyRecord } from './types.js';

export interface Bundle {
  manifest: { revision: string; schemaVersion: 1; createdAt: string; sha256: string };
  policy: PolicyDoc;
  prices: PriceTable;
  keys: KeyRecord[];
}

/** Largest bundle the loader accepts, from a file, the state dir or a URL. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** Canonical JSON: object keys sorted at every level, undefined members dropped, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

const sortedKeys = (keys: readonly KeyRecord[]): KeyRecord[] => [...keys].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

function contentSha(policy: unknown, prices: unknown, keys: unknown): string {
  return sha256Hex(canonicalJson({ policy, prices, keys }));
}

/** `revision` defaults to the first 12 hex characters of the content sha256 (CI passes GITHUB_SHA). */
export function buildBundle(src: PolicySource, o: { revision?: string; createdAt: string }): Bundle {
  // A JSON round trip first, so what is hashed is exactly what a reader of the written file sees.
  const policy = JSON.parse(JSON.stringify(src.policy)) as PolicyDoc;
  const prices = JSON.parse(JSON.stringify(src.prices)) as PriceTable;
  const keys = sortedKeys(JSON.parse(JSON.stringify(src.keys)) as KeyRecord[]);
  const sha256 = contentSha(policy, prices, keys);
  const revision = o.revision && o.revision.length > 0 ? o.revision : sha256.slice(0, 12);
  return { manifest: { revision, schemaVersion: 1, createdAt: o.createdAt, sha256 }, policy, prices, keys };
}

export const serializeBundle = (b: Bundle): string => `${JSON.stringify(b, null, 2)}\n`;

const bad = (message: string): never => {
  throw new PolicyLoadError('E_BUNDLE', 'bundle', [{ path: '', message }]);
};

/** JSON.parse keeps "__proto__" as an own key; it is refused at any depth, as safe-yaml does. */
function rejectProtoKeys(v: unknown, depth = 0): void {
  if (depth > 64) bad('bundle is nested too deeply');
  if (Array.isArray(v)) return v.forEach((x) => rejectProtoKeys(x, depth + 1));
  if (typeof v === 'object' && v !== null) {
    if (Object.hasOwn(v, '__proto__')) bad('key __proto__ is not allowed');
    for (const x of Object.values(v)) rejectProtoKeys(x, depth + 1);
  }
}

/** Parses a bundle file: size cap, no __proto__ keys, manifest shape, sha256 over the content, then the policy, price and key schemas. Throws PolicyLoadError. */
export function parseBundle(text: string): Bundle {
  if (text.length > MAX_BUNDLE_BYTES) bad(`bundle is larger than ${MAX_BUNDLE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return bad(`bundle is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  rejectProtoKeys(raw);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('bundle must be a JSON object');
  const b = raw as Record<string, unknown>;
  const m = b.manifest;
  if (typeof m !== 'object' || m === null) return bad('manifest is missing');
  const mm = m as Record<string, unknown>;
  if (mm.schemaVersion !== 1) bad('manifest.schemaVersion must be 1');
  if (typeof mm.revision !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(mm.revision)) bad('manifest.revision must be 1 to 64 characters of letters, digits, dot, dash or underscore');
  if (typeof mm.createdAt !== 'string') bad('manifest.createdAt must be a string');
  if (typeof mm.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(mm.sha256)) bad('manifest.sha256 must be 64 hex characters');
  const actual = contentSha(b.policy, b.prices, b.keys);
  if (actual !== mm.sha256) bad(`sha256 mismatch: manifest says ${String(mm.sha256).slice(0, 12)}, content is ${actual.slice(0, 12)}`);

  const p = policySchema.safeParse(b.policy);
  if (!p.success) throw new PolicyLoadError('E_BUNDLE', 'bundle', p.error.issues.map((i) => ({ path: `policy.${i.path.join('.')}`, message: i.message })));
  let prices: PriceTable;
  try {
    prices = parsePriceTable(JSON.stringify(b.prices));
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
  const k = keysFileSchema.safeParse(b.keys);
  if (!k.success) throw new PolicyLoadError('E_BUNDLE', 'bundle', k.error.issues.map((i) => ({ path: `keys.${i.path.join('.')}`, message: i.message })));
  return { manifest: { revision: mm.revision as string, schemaVersion: 1, createdAt: mm.createdAt as string, sha256: mm.sha256 as string }, policy: p.data, prices, keys: k.data };
}

/** A bundle as the PolicySource that validatePolicy and compilePolicy take. */
export function bundleToSource(b: Bundle): PolicySource {
  return { dir: 'bundle', policy: b.policy, prices: b.prices, keys: b.keys, normalizedFiles: {} };
}
