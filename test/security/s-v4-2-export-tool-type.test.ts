// S-V4-2 (V4 anonymizer fuzz, LOW): `traces export --anonymize` kept every server tool type shaped like an identifier
// (`[a-z0-9_]{1,64}`, the ingest bound of B1), so a lowercase token or hex secret a client put in `tools[].type`
// (`ghp_0000a0aa0a000aa0`, a 32-hex API key) reached the export in clear. Exports pseudonymise them; since S-V4-3 they
// keep only the server tool types a provider documents (`web_search_20250305`, `file_search`, `mcp`), whatever shape
// the rest has. Replay is unchanged, as an unknown type is unpriced under either name.
import { expect, test } from 'vitest';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import { baseRecord } from '../helpers/trace.js';

const p = saltedPseudonyms('s');
const exported = (type: string): string => {
  const r = baseRecord();
  const out = anonymizeRecord({ ...r, instance: 'i', seq: 1, features: { ...r.features, serverTools: [{ type, maxUses: 1 }] } }, p);
  return out.features.serverTools[0]?.type as string;
};

// Built from parts at runtime, so no committed file holds a secret-shaped value (check:secrets, push protection).
test('S-V4-2 identifier-shaped secrets in a server tool type are pseudonymised in exports', () => {
  const hex = '9f86d081884c7d659a2feaa0c55ad015';
  for (const secret of ['ghp_0000a0aa0a000aa0', hex, ['sk', '_live_', '4ec39hqlyjwdarjtt1zdp7dc'].join(''), 'tool_x9_20250101']) {
    const out = exported(secret);
    expect(out).not.toContain(secret);
    expect(out).toBe(exported(secret)); // stable within one salt
  }
});

test('S-V4-2 real tool types stay readable (replay prices and allow-lists them by type)', () => {
  for (const t of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'tool_search_tool_regex_20251119', 'bash_20250124', 'web_search', 'file_search', 'code_interpreter', 'image_generation', 'computer_use_preview', 'mcp', '(invalid)']) {
    expect(exported(t)).toBe(t);
  }
});
