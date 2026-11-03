// S-V7-1 (V7 sweep, Low): the leak guard for examples/live (test/docs/readme.test.ts, "no record, instance, session ...
// id from the raw live traces") checks the ids bench/live-summary.ts collects into .live/raw-names.json. That list
// did not hold the linkable ids added in V4: the process epoch (`decision.seqEpoch`, S-V4-4) and the raw traces'
// server tool placeholders (`tool_<16 hex>`, S-V4-3). The committed export held none of them (checked by hand in V7),
// but a regression of S-V4-3 or S-V4-4 in the anonymizer would not have been caught by the guard. Local only: the raw
// traces are gitignored, so this runs on the machine that holds them, never in CI. Ids are counted, never printed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const RAW_DIR = join(ROOT, '.live', 'traces');
const RAW_NAMES = join(ROOT, '.live', 'raw-names.json');

function rawLinkableIds(): Set<string> {
  const out = new Set<string>();
  const files = readdirSync(RAW_DIR, { recursive: true, encoding: 'utf8' }).map((f) => join(RAW_DIR, f)).filter((f) => f.endsWith('.ndjson') && statSync(f).isFile());
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line === '') continue;
      let r: { kind?: string; decision?: { seqEpoch?: string }; candidateDecision?: { seqEpoch?: string }; features?: { serverTools?: Array<{ type: string }> } };
      try {
        r = JSON.parse(line) as typeof r;
      } catch {
        continue;
      }
      for (const e of [r.decision?.seqEpoch, r.candidateDecision?.seqEpoch]) if (e) out.add(e);
      for (const t of r.features?.serverTools ?? []) if (/^tool_[0-9a-f]{16}$/.test(t.type)) out.add(t.type);
    }
  }
  return out;
}

describe.skipIf(Boolean(process.env.CI) || !existsSync(RAW_DIR) || !existsSync(RAW_NAMES))('S-V7-1 live leak guard (local only)', () => {
  test('S-V7-1 the raw ids the examples/live guard checks include every process epoch and tool placeholder of the raw traces', () => {
    const wanted = rawLinkableIds();
    expect(wanted.size).toBeGreaterThan(0);
    const listed = new Set((JSON.parse(readFileSync(RAW_NAMES, 'utf8')) as { ids?: string[] }).ids ?? []);
    const missing = [...wanted].filter((id) => !listed.has(id)).length;
    expect(missing, `${missing} of ${wanted.size} linkable ids are not in .live/raw-names.json`).toBe(0);
  });
});
