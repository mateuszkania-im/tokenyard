// `npm run check:secrets [file.tgz ...]`: fails when a tracked file, or a file given as an argument (the npm tarball in
// CI), holds a string one of the gateway's secret rules matches. Stand-alone (plain node, no imports from src), so the
// pre-commit hook and CI run it before anything is built. .gz files are gunzipped and tar archives (.tgz, .tar) are
// walked entry by entry, a .gz inside one included. Prints the rule id and the file, never the value.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// The rules of src/guardrails/rules.ts without the entropy-only one; written by scripts/sync-secret-rules.ts.
// BEGIN RULES (generated: npx tsx scripts/sync-secret-rules.ts)
const RULES = [{"id":"aws-access-key-id","keywords":["AKIA","ASIA"],"source":"\\b((?:AKIA|ASIA)[A-Z2-7]{16})\\b","flags":""},{"id":"github-pat","keywords":["ghp_"],"source":"\\b(ghp_[0-9A-Za-z]{36})\\b","flags":""},{"id":"github-oauth","keywords":["gho_"],"source":"\\b(gho_[0-9A-Za-z]{36})\\b","flags":""},{"id":"github-app-token","keywords":["ghs_","ghu_"],"source":"\\b((?:ghs|ghu)_[0-9A-Za-z]{36})\\b","flags":""},{"id":"github-fine-grained-pat","keywords":["github_pat_"],"source":"\\b(github_pat_\\w{82})\\b","flags":""},{"id":"slack-token","keywords":["xoxa-","xoxb-","xoxp-","xoxo-","xoxs-","xoxr-"],"source":"(?<![0-9A-Za-z_-])(xox[abposr]-\\d{6,13}-[0-9A-Za-z-]{10,256})","flags":""},{"id":"stripe-live-key","keywords":["sk_live_","rk_live_"],"source":"(?<![0-9A-Za-z_])((?:sk|rk)_live_[0-9A-Za-z]{10,99})(?![0-9A-Za-z_])","flags":""},{"id":"private-key","keywords":["-----BEGIN"],"source":"(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:[^\\0-]|-(?!----)){64,65536}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)","flags":""},{"id":"jwt","keywords":["eyJ"],"source":"(?<![0-9A-Za-z_-])(eyJ[0-9A-Za-z_-]{15,4096}\\.eyJ[0-9A-Za-z_-]{15,16384}\\.[0-9A-Za-z_-]{10,4096})","flags":""},{"id":"anthropic-api-key","keywords":["sk-ant-"],"source":"(?<![0-9A-Za-z_-])(sk-ant-[a-z]{2,8}\\d{2}-[0-9A-Za-z_-]{80,512})","flags":""},{"id":"openai-api-key","keywords":["sk-proj-","sk-svcacct-","sk-admin-"],"source":"(?<![0-9A-Za-z_-])(sk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{40,512})","flags":""},{"id":"google-api-key","keywords":["AIza"],"source":"(?<![0-9A-Za-z_-])(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])","flags":""},{"id":"tokenyard-key","keywords":["ty_live_"],"source":"\\b(ty_live_[0-9A-Za-z]{43})\\b","flags":""}];
// END RULES

/** Fakes the repo uses on purpose: the documented test canary prefix and AWS's own documentation example key. */
const ALLOWED = [/^sk-ant-test-CANARY/, /^AKIAIOSFODNN7EXAMPLE$/];
/** Decompressed bytes per file at most (the demo export is a few MB); larger is reported, not silently skipped. */
const MAX_INFLATED = 512 * 1024 * 1024;

const compiled = RULES.map((r) => ({ ...r, re: new RegExp(r.source, r.flags.includes('g') ? r.flags : `${r.flags}g`) }));

/** Rule ids that match `buf`, allowed fakes left out. */
function hits(buf) {
  const text = buf.toString('latin1');
  const out = new Set();
  for (const r of compiled) {
    if (r.keywords.length > 0 && !r.keywords.some((k) => text.includes(k))) continue;
    r.re.lastIndex = 0;
    for (const m of text.matchAll(r.re)) {
      const value = m[1] ?? m[0];
      if (!ALLOWED.some((a) => a.test(value))) out.add(r.id);
    }
  }
  return [...out];
}

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isTar = (b) => b.length >= 512 && b.toString('latin1', 257, 262) === 'ustar';

/** Entries of a ustar archive: name and contents. */
function* tarEntries(b) {
  for (let off = 0; off + 512 <= b.length; ) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) return;
    const str = (s, e) => h.toString('utf8', s, e).replace(/\0.*$/s, '');
    const name = [str(345, 500), str(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(str(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');
    yield { name, data: b.subarray(off + 512, off + 512 + size), type: str(156, 157) };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

/** Findings for one file's bytes: `label: rule` strings. */
function scan(label, buf) {
  if (isGzip(buf)) buf = gunzipSync(buf, { maxOutputLength: MAX_INFLATED });
  if (isTar(buf)) {
    const out = [];
    for (const e of tarEntries(buf)) if (e.type === '0' || e.type === '') out.push(...scan(`${label}!${e.name}`, e.data));
    return out;
  }
  return hits(buf).map((rule) => `${rule} in: ${label}`);
}

if (RULES.length === 0) {
  console.error('check:secrets: no rules embedded; run npx tsx scripts/sync-secret-rules.ts');
  process.exit(2);
}
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
files.push(...process.argv.slice(2));
const findings = [];
let scanned = 0;
for (const file of files) {
  let data;
  try {
    data = readFileSync(file);
  } catch {
    continue; // deleted in the working tree
  }
  scanned++;
  try {
    findings.push(...scan(file, data));
  } catch (e) {
    findings.push(`unreadable archive (${e instanceof Error ? e.message : String(e)}) in: ${file}`);
  }
}
if (findings.length > 0) {
  for (const f of findings) console.error(`possible secret, ${f}`);
  process.exit(1);
}
console.log(`no secrets found in ${scanned} files`);
