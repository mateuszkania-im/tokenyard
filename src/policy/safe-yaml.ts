// Policy files come from pull requests, so YAML is parsed as plain data and nothing else. Pure: parses text, no I/O.
import { isScalar, parseDocument, visit } from 'yaml';

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

/**
 * Parses one YAML document into plain data. Refuses, with E_YAML_UNSAFE: any alias (so no alias or anchor bombs;
 * the aliases are never expanded), merge keys (`<<`), `__proto__` keys and files over 1 MB.
 * Everything else the parser rejects is E_YAML_SYNTAX.
 */
export function parseYamlSafe(text: string): unknown {
  if (text.length > MAX_YAML_BYTES) throw new YamlError('E_YAML_UNSAFE', `file is larger than ${MAX_YAML_BYTES} bytes`);
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text, { uniqueKeys: true, merge: false });
  } catch (e) {
    throw new YamlError('E_YAML_SYNTAX', e instanceof Error ? e.message : String(e));
  }
  const first = doc.errors[0];
  if (first) throw new YamlError('E_YAML_SYNTAX', first.message.split('\n')[0] ?? 'syntax error');
  visit(doc, {
    Alias: () => {
      throw new YamlError('E_YAML_UNSAFE', 'YAML aliases are not allowed in policy files');
    },
    Pair: (_k, pair) => {
      if (isScalar(pair.key) && pair.key.value === '<<') throw new YamlError('E_YAML_UNSAFE', 'YAML merge keys (<<) are not allowed in policy files');
      if (isScalar(pair.key) && pair.key.value === '__proto__') throw new YamlError('E_YAML_UNSAFE', 'key __proto__ is not allowed');
    },
  });
  try {
    return doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    throw new YamlError('E_YAML_SYNTAX', e instanceof Error ? e.message : String(e));
  }
}
