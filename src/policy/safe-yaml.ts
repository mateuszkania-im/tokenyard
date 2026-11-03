// Policy files come from pull requests, so YAML is parsed as plain data and nothing else. Pure: parses text, no I/O.
import { isCollection, isScalar, parseDocument, visit } from 'yaml';

export type YamlErrorCode = 'E_YAML_UNSAFE' | 'E_YAML_SYNTAX';

export class YamlError extends Error {
  constructor(
    readonly code: YamlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'YamlError';
  }
}

export const MAX_YAML_BYTES = 1_000_000;
/** Nodes (mappings, sequences, pairs, scalars) one document may hold; bounds the work after parsing. */
export const MAX_YAML_NODES = 200_000;

const DEFAULT_TAGS = { '!!': 'tag:yaml.org,2002:' } as const;

/** The property name a scalar key becomes in the JS object: null (`~`, `null`, empty) is "", the rest String(value). */
const jsKey = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * Parses one YAML 1.2 document into plain data. Refuses, with E_YAML_UNSAFE: any directive except `%YAML 1.2` (1.1
 * re-enables merge keys and its own scalar typing; `%TAG` renames tags), any alias (so no alias or anchor bombs; the
 * aliases are never expanded), merge keys (`<<`), `__proto__` keys, mappings or sequences used as keys, more than
 * MAX_YAML_NODES nodes and files over 1 MB. Two keys of one mapping that become the same property name (`1` and "1",
 * `true` and "true", `~` and "") are E_YAML_SYNTAX, like any other duplicate key. Linear in the size of the document.
 */
export function parseYamlSafe(text: string): unknown {
  if (text.length > MAX_YAML_BYTES) throw new YamlError('E_YAML_UNSAFE', `file is larger than ${MAX_YAML_BYTES} bytes`);
  let doc: ReturnType<typeof parseDocument>;
  try {
    // uniqueKeys is off: the library's check is quadratic and compares parsed values; the visit below does it per map.
    doc = parseDocument(text, { uniqueKeys: false, merge: false, version: '1.2' });
  } catch (e) {
    throw new YamlError('E_YAML_SYNTAX', e instanceof Error ? e.message : String(e));
  }
  const first = doc.errors[0];
  if (first) throw new YamlError('E_YAML_SYNTAX', first.message.split('\n')[0] ?? 'syntax error');
  const yaml = doc.directives?.yaml;
  const tags = doc.directives?.tags ?? DEFAULT_TAGS;
  const customTags = Object.keys(tags).some((k) => k !== '!!' || tags[k] !== DEFAULT_TAGS['!!']);
  if ((yaml?.explicit && yaml.version !== '1.2') || customTags || doc.warnings.some((w) => w.code === 'BAD_DIRECTIVE')) {
    throw new YamlError('E_YAML_UNSAFE', 'YAML directives other than %YAML 1.2 are not allowed in policy files');
  }
  let nodes = 0;
  visit(doc, {
    Node: () => {
      if (++nodes > MAX_YAML_NODES) throw new YamlError('E_YAML_UNSAFE', `document has more than ${MAX_YAML_NODES} nodes`);
    },
    Alias: () => {
      throw new YamlError('E_YAML_UNSAFE', 'YAML aliases are not allowed in policy files');
    },
    Map: (_k, map) => {
      const seen = new Set<string>();
      for (const pair of map.items) {
        if (isCollection(pair.key)) throw new YamlError('E_YAML_UNSAFE', 'mappings and sequences are not allowed as keys');
        const value = isScalar(pair.key) ? pair.key.value : pair.key;
        if (value === '<<') throw new YamlError('E_YAML_UNSAFE', 'YAML merge keys (<<) are not allowed in policy files');
        if (value === '__proto__') throw new YamlError('E_YAML_UNSAFE', 'key __proto__ is not allowed');
        const key = jsKey(value);
        if (seen.has(key)) throw new YamlError('E_YAML_SYNTAX', `Map keys must be unique (duplicate key ${JSON.stringify(key.slice(0, 64))})`);
        seen.add(key);
      }
    },
  });
  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    throw new YamlError('E_YAML_SYNTAX', e instanceof Error ? e.message : String(e));
  }
}
