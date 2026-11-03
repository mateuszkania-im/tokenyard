// B4 (security review B): `npm run check:secrets` matched only sk-ant-/sk-proj- keys in plain bytes. It missed
// sk-svcacct-, sk-admin-, ty_live_ keys, anything inside the tracked .gz trace files and the npm tarball (scanned as
// compressed bytes), and CI never packed the tarball. The script now uses the gateway's own secret rules (embedded,
// kept in sync by the last test here), gunzips .gz and .tgz files and walks tar entries; only the repo's fake
// `sk-ant-test-CANARY` prefix and AWS's documented example key are allowed.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-no-secrets.mjs');
const b62 = (n: number): string => [...randomBytes(n)].map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');

/** Runs a copy of the script (as the probe does: it must work stand-alone) in a throwaway repo holding `files`. */
function runIn(files: Record<string, Buffer | string>, extraArgs: Record<string, Buffer> = {}): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ty-b4-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(repo, name, '..'), { recursive: true });
      writeFileSync(join(repo, name), data);
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    copyFileSync(SCRIPT, join(dir, 'check.mjs'));
    for (const [name, data] of Object.entries(extraArgs)) writeFileSync(join(repo, name), data);
    const r = spawnSync(process.execPath, [join(dir, 'check.mjs'), ...Object.keys(extraArgs)], { cwd: repo, encoding: 'utf8' });
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A minimal ustar archive: one 512-byte header per entry, contents padded to 512 bytes, two zero blocks at the end. */
function tar(entries: Record<string, Buffer | string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const body = Buffer.from(data);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const ANT = `sk-ant-api03-CANARY${b62(80)}`;

describe('B4 check:secrets', () => {
  it('finds a plain sk-ant key and names the rule and file, never the value', () => {
    const r = runIn({ 'a.txt': `k=${ANT}\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('anthropic-api-key');
    expect(r.out).toContain('a.txt');
    expect(r.out).not.toContain(ANT.slice(0, 24));
  });
  it('finds sk-svcacct-, sk-admin- and ty_live_ keys', () => {
    expect(runIn({ 'a.txt': `k=sk-svcacct-CANARY${b62(60)}\n` }).status).toBe(1);
    expect(runIn({ 'a.txt': `k=sk-admin-CANARY${b62(60)}\n` }).status).toBe(1);
    expect(runIn({ 'a.txt': `ANTHROPIC_API_KEY=ty_live_${b62(43)}\n` }).status).toBe(1);
  });
  it('finds a key inside a tracked .gz file', () => {
    expect(runIn({ 'examples/live/live.ndjson.gz': gzipSync(Buffer.from(`{"features":{"model":"${ANT}"}}\n`)) }).status).toBe(1);
  });
  it('finds a key in a tar entry of the tarball argument, and in a .gz inside it', () => {
    const r = runIn({ 'a.txt': 'clean\n' }, { 'pkg.tgz': gzipSync(tar({ 'package/README.md': 'clean\n', 'package/bin/x.mjs': `const k = "${ANT}";\n` })) });
    expect(r.status).toBe(1);
    expect(r.out).toContain('package/bin/x.mjs');
    expect(runIn({ 'a.txt': 'clean\n' }, { 'pkg.tgz': gzipSync(tar({ 'package/t.ndjson.gz': gzipSync(Buffer.from(ANT)) })) }).status).toBe(1);
    // A gzip that is not a tar archive is scanned as text (security probe B4e).
    expect(runIn({ 'a.txt': 'clean\n' }, { 'pkg.tgz': gzipSync(Buffer.from(`package/README.md\0${ANT}\n`)) }).status).toBe(1);
  });
  it('allows the fake sk-ant-test-CANARY prefix and the documented AWS example key; a clean tarball passes', () => {
    const r = runIn({ 'a.txt': `k=sk-ant-test-CANARY-${b62(40)}\naws=AKIAIOSFODNN7EXAMPLE\n` }, { 'pkg.tgz': gzipSync(tar({ 'package/README.md': 'clean\n' })) });
    expect(r.status, r.out).toBe(0);
  });
  it('fails when a file named as an argument is missing, empty-named or unreadable (an empty npm pack must not pass)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ty-b4-arg-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      for (const arg of ['missing.tgz', '', dir]) {
        const r = spawnSync(process.execPath, [SCRIPT, arg], { cwd: dir, encoding: 'utf8' });
        expect(r.status, JSON.stringify(arg)).not.toBe(0);
        expect(r.stderr).toMatch(/cannot read/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('CI checks that npm pack produced a file before scanning it', () => {
    expect(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('t=$(npm pack --silent) && test -f "$t" && npm run check:secrets -- "$t"');
  });
  it('the pre-commit hook scans the staged blobs, not the working tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ty-b4-hook-'));
    try {
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, '.githooks'));
      copyFileSync(SCRIPT, join(dir, 'scripts', 'check-no-secrets.mjs'));
      copyFileSync(join(ROOT, '.githooks', 'pre-commit'), join(dir, '.githooks', 'pre-commit'));
      git('config', 'core.hooksPath', '.githooks'); // the throwaway repo only
      git('add', '-A');
      expect(git('commit', '-q', '-m', 'clean').status).toBe(0);
      // A secret staged, then removed from the working copy: the commit would still record it.
      writeFileSync(join(dir, 'a.txt'), `k=${ANT}\n`);
      git('add', 'a.txt');
      writeFileSync(join(dir, 'a.txt'), 'clean\n');
      const r = git('commit', '-q', '-m', 'leak');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('anthropic-api-key in: a.txt');
      // The other way round: a secret only in the working copy does not block a clean staged blob.
      git('add', 'a.txt');
      writeFileSync(join(dir, 'b.txt'), 'clean\n');
      git('add', 'b.txt');
      writeFileSync(join(dir, 'b.txt'), `k=${ANT}\n`);
      expect(git('commit', '-q', '-m', 'ok').status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the embedded rules are the gateway rules (DEFAULT_RULES without the entropy-only ones)', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const block = /\/\/ BEGIN RULES[^\n]*\n([\s\S]*?)\n\/\/ END RULES/.exec(text)?.[1] ?? '';
    const expected = DEFAULT_RULES.filter((r) => !r.entropyOnly).map((r) => ({ id: r.id, keywords: r.keywords, source: r.regex.source, flags: r.regex.flags }));
    expect(JSON.parse(block.replace(/^const RULES = /, '').replace(/;$/, '')), 'run: npx tsx scripts/sync-secret-rules.ts').toEqual(expected);
  });
});
