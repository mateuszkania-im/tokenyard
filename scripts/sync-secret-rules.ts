// Writes the gateway's secret rules (src/guardrails/rules.ts, entropy-only rules left out) into the RULES block of
// scripts/check-no-secrets.mjs, which must run stand-alone with plain node. test/security/b4-check-secrets.test.ts fails
// when the block is stale. Run: npx tsx scripts/sync-secret-rules.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RULES } from '../src/guardrails/rules.js';

const file = join(import.meta.dirname, 'check-no-secrets.mjs');
const rules = DEFAULT_RULES.filter((r) => !r.entropyOnly).map((r) => ({ id: r.id, keywords: r.keywords, source: r.regex.source, flags: r.regex.flags }));
const text = readFileSync(file, 'utf8');
const next = text.replace(/(\/\/ BEGIN RULES[^\n]*\n)[\s\S]*?(\n\/\/ END RULES)/, `$1const RULES = ${JSON.stringify(rules)};$2`);
writeFileSync(file, next);
console.log(next === text ? 'rules already in sync' : `wrote ${rules.length} rules`);
