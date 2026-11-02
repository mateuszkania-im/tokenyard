// Spec 6.6 "measured, not assumed": source trees and lockfiles sent as tool results must give zero block hits.
// Sources are listed in test/fixtures/fp-corpus/README.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { pseudonym } from '../../src/guardrails/hmac.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
/**
 * Files that hold positives on purpose, per tree: secret-scanner tests (tokenyard's own rule and taint tests, why-diff's
 * redaction tests). Listed in test/fixtures/fp-corpus/README.md.
 */
const POSITIVE_FIXTURES: Record<string, RegExp[]> = {
  tokenyard: [/^test\/guardrails\//, /^test\/edge\/taint\.test\.ts$/],
  'why-diff': [/^test\/redact\.test\.ts$/],
};
/** AWS's documented example key id: the demo and the rule tests use it as a positive on purpose (it must match). */
const DOCUMENTED_EXAMPLES = ['AKIAIOSFODNN7EXAMPLE'];
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function gitFiles(dir: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** Trees to scan: tokenyard itself, ../why-diff when checked out beside it, and every path in TOKENYARD_FP_CORPUS. */
function corpus(): Array<{ label: string; file: string }> {
  const trees = [ROOT, resolve(ROOT, '..', 'why-diff'), ...(process.env.TOKENYARD_FP_CORPUS ?? '').split(delimiter).filter(Boolean).map((p) => resolve(p))];
  const out: Array<{ label: string; file: string }> = [];
  for (const tree of new Set(trees)) {
    if (!existsSync(tree)) continue;
    const name = tree === ROOT ? 'tokenyard' : basename(tree);
    for (const rel of gitFiles(tree)) {
      if ((POSITIVE_FIXTURES[name] ?? []).some((re) => re.test(rel))) continue;
      const file = join(tree, rel);
      try {
        const st = statSync(file);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push({ label: `${name}:${rel}`, file });
    }
  }
  return out;
}

test('false-positive corpus (why-diff, read-receipts, tokenyard trees, lockfiles, fixtures) gives zero block hits', () => {
  const files = corpus();
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((f) => f.file.endsWith('package-lock.json'))).toBe(true);
  const offenders: string[] = [];
  const documented = new Set(DOCUMENTED_EXAMPLES.map((v) => pseudonym('fp', v)));
  let examples = 0;
  let bytes = 0;
  for (const { label, file } of files) {
    const text = readFileSync(file).toString('utf8');
    bytes += text.length;
    // Each file arrives the way Claude Code sends a file it read: a tool_result in the newest user turn.
    const body = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] }] }));
    const f = extractAnthropicFeatures(body);
    const hits = scanBody(body, f.lastTurn, DEFAULT_RULES, () => 'block', 'fp', { messages: f.messages });
    for (const h of hits) {
      if (h.action !== 'block') continue;
      if (documented.has(h.valueHmac)) examples++;
      else offenders.push(`${label} (${h.rule})`);
    }
  }
  console.log(`fp corpus: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB; documented example values matched: ${examples}; block hits: ${offenders.length}`);
  expect(offenders).toEqual([]);
});
