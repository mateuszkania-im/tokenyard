// Turns the text of a policy directory into a validated PolicySource. Pure: the caller reads the files (R-P2).
import { parsePriceTable, type PriceTable } from '../pricing/prices.js';
import type { KeyRecord } from './types.js';
import { keysFileSchema, policySchema, type PolicyDoc } from './schema.js';
import { parseYamlSafe, YamlError } from './safe-yaml.js';

export interface PolicySource {
  dir: string;
  policy: PolicyDoc;
  prices: PriceTable;
  keys: KeyRecord[];
  /** The three files after BOM stripping and CRLF to LF conversion, keyed by file name. This is what a bundle hashes. */
  normalizedFiles: Record<string, string>;
}

export type LoadErrorCode = 'E_FILE_MISSING' | 'E_YAML_UNSAFE' | 'E_YAML_SYNTAX' | 'E_SCHEMA' | 'E_PRICES_INVALID' | 'E_MODEL_LIMITS_MISSING' | 'E_BUNDLE';

export interface LoadIssue {
  code: string;
  path: string;
  message: string;
}

/** A policy directory that cannot be loaded. `issues` lists every problem found in the failing file. */
export class PolicyLoadError extends Error {
  readonly issues: LoadIssue[];
  constructor(
    readonly code: LoadErrorCode,
    readonly file: string,
    issues: Array<{ path: string; message: string }>,
  ) {
    const first = issues[0];
    super(`${code} ${file}${first && first.path ? ` ${first.path}` : ''}: ${first?.message ?? 'invalid'}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`);
    this.name = 'PolicyLoadError';
    this.issues = issues.map((i) => ({ code, path: i.path ? `${file}:${i.path}` : file, message: i.message }));
  }
}

export const POLICY_FILE = 'policy.yaml';
const DEFAULT_PRICES = 'prices.yaml';
const DEFAULT_KEYS = 'keys.yaml';

/** Strips a UTF-8 BOM and converts CRLF to LF, so a file edited on Windows hashes and parses the same. */
export function normalizeText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n');
}

const bare = (ref: string): string => ref.replace(/^\.\//, '');

/**
 * The file names the loader must read: policy.yaml plus the files its `pricing` and `keys` fields name
 * (defaults prices.yaml and keys.yaml). A policy that does not parse yields the defaults; parsePolicyFiles reports the real error.
 */
export function policyFileNames(policyText: string): string[] {
  let pricing = DEFAULT_PRICES;
  let keys = DEFAULT_KEYS;
  try {
    const raw = parseYamlSafe(normalizeText(policyText));
    if (typeof raw === 'object' && raw !== null) {
      const r = raw as Record<string, unknown>;
      if (typeof r.pricing === 'string' && /^(\.\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(r.pricing)) pricing = bare(r.pricing);
      if (typeof r.keys === 'string' && /^(\.\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(r.keys)) keys = bare(r.keys);
    }
  } catch {
    // reported by parsePolicyFiles
  }
  return [...new Set([POLICY_FILE, pricing, keys])];
}

function yamlOf(file: string, text: string): unknown {
  try {
    return parseYamlSafe(text);
  } catch (e) {
    if (e instanceof YamlError) throw new PolicyLoadError(e.code, file, [{ path: '', message: e.message }]);
    throw e;
  }
}

const pathOf = (p: ReadonlyArray<PropertyKey>): string => p.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '');

/** `files` maps file names (as the policy names them, without `./`) to their raw text. Throws PolicyLoadError. */
export function parsePolicyFiles(dir: string, files: Record<string, string>): PolicySource {
  const get = (name: string): string => {
    const text = Object.hasOwn(files, name) ? files[name] : undefined;
    if (text === undefined) throw new PolicyLoadError('E_FILE_MISSING', name, [{ path: '', message: `${name} not found in ${dir}` }]);
    return normalizeText(text);
  };

  const policyText = get(POLICY_FILE);
  const p = policySchema.safeParse(yamlOf(POLICY_FILE, policyText));
  if (!p.success) throw new PolicyLoadError('E_SCHEMA', POLICY_FILE, p.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })));
  const policy = p.data;

  const pricesName = bare(policy.pricing);
  const keysName = bare(policy.keys);
  const pricesText = get(pricesName);
  const keysText = get(keysName);

  let prices: PriceTable;
  try {
    prices = parsePriceTable(pricesText);
  } catch (e) {
    if (e instanceof YamlError) throw new PolicyLoadError(e.code, pricesName, [{ path: '', message: e.message }]);
    const message = e instanceof Error ? e.message.replace(/^invalid price table: /, '') : String(e);
    const code = /\.(maxContextTokens|maxOutputTokens):/.test(message) ? 'E_MODEL_LIMITS_MISSING' : 'E_PRICES_INVALID';
    throw new PolicyLoadError(code, pricesName, [{ path: '', message }]);
  }

  const rawKeys = yamlOf(keysName, keysText) ?? [];
  const k = keysFileSchema.safeParse(rawKeys);
  if (!k.success) throw new PolicyLoadError('E_SCHEMA', keysName, k.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message })));
  const seenHash = new Set<string>();
  const seenId = new Set<string>();
  k.data.forEach((rec, i) => {
    if (seenHash.has(rec.hash) || seenId.has(rec.keyId)) throw new PolicyLoadError('E_SCHEMA', keysName, [{ path: `[${i}]`, message: 'duplicate key hash or keyId' }]);
    seenHash.add(rec.hash);
    seenId.add(rec.keyId);
  });

  const normalizedFiles: Record<string, string> = {};
  normalizedFiles[POLICY_FILE] = policyText;
  normalizedFiles[pricesName] = pricesText;
  normalizedFiles[keysName] = keysText;
  return { dir, policy, prices, keys: k.data, normalizedFiles };
}
