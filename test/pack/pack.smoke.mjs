#!/usr/bin/env node
// Pack smoke test (CI: Linux and Windows): `npm pack` into a temp dir, install the tarball into an empty project and
// run the installed command. Asserts the tarball ships no dependencies and only the files the package promises, and that
// the secret scan passes on the tarball itself. Never publishes anything.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(tmpdir(), 'tokenyard-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
};

/** Runs a command, returns { status, stdout, stderr }; on Windows .cmd shims need a shell. */
function run(cmd, args, cwd, extraEnv = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, ...extraEnv }, timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Entry names (without the leading "package/") of a gzipped tar. */
function tarEntries(tgz) {
  const buf = gunzipSync(readFileSync(tgz));
  const names = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (name === '') break;
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    names.push(name.replace(/^package\//, ''));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

try {
  const packDir = join(work, 'pack');
  mkdirSync(packDir);
  const packed = run(npm, ['pack', '--silent', '--pack-destination', packDir], root);
  check(packed.status === 0, 'npm pack succeeds');
  const tgzName = packed.stdout.trim().split('\n').pop()?.trim() ?? '';
  const tgz = join(packDir, tgzName);
  check(tgzName.endsWith('.tgz') && existsSync(tgz), `tarball exists (${tgzName})`);

  const names = tarEntries(tgz);
  const allowed = new Set(['package.json', 'LICENSE', 'README.md', 'action.yml']);
  const stray = names.filter((n) => !(allowed.has(n) || /^bin\/[^/]+$/.test(n)));
  check(stray.length === 0, `tarball holds only bin/, action.yml, LICENSE, README.md, package.json${stray.length ? ` (stray: ${stray.join(', ')})` : ''}`);
  for (const must of ['bin/tokenyard.mjs', 'action.yml', 'LICENSE', 'README.md', 'package.json']) check(names.includes(must), `tarball contains ${must}`);

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check(manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0, 'package.json has no dependencies');
  check(manifest.publishConfig?.access === 'public' && manifest.publishConfig?.provenance === true, 'publishConfig is public with provenance');
  check(typeof manifest.repository === 'object' || typeof manifest.repository === 'string', 'package.json has a repository');
  check(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, 'package.json has keywords');

  const scan = run(process.execPath, [join(root, 'scripts', 'check-no-secrets.mjs'), tgz], root);
  check(scan.status === 0, 'check-no-secrets passes on the tarball');

  // An empty project with only the tarball installed.
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true, version: '0.0.0' }));
  const install = run(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', tgz], project);
  check(install.status === 0, `npm install of the tarball succeeds${install.status === 0 ? '' : `: ${install.stderr.slice(0, 400)}`}`);
  const installedPkg = JSON.parse(readFileSync(join(project, 'node_modules', '@mateuszkania-im', 'tokenyard', 'package.json'), 'utf8'));
  check(installedPkg.dependencies === undefined, 'installed package has no dependencies');

  const version = run(npm, ['exec', '--no', '--', 'tokenyard', '--version'], project);
  check(version.status === 0 && version.stdout.trim() === manifest.version, `tokenyard --version prints ${manifest.version}`);

  const policyDir = join(project, 'policy');
  cpSync(join(root, 'examples', 'policy'), policyDir, { recursive: true });
  const policy = run(npm, ['exec', '--no', '--', 'tokenyard', 'policy', 'check', 'policy'], project);
  check(policy.status === 0, `tokenyard policy check on the copied example passes${policy.status === 0 ? '' : `: ${(policy.stdout + policy.stderr).slice(0, 400)}`}`);

  const demo = run(npm, ['exec', '--no', '--', 'tokenyard', 'demo'], project);
  check(demo.status === 0 && /tokenyard policy replay/.test(demo.stdout + demo.stderr), `tokenyard demo runs and prints the replay${demo.status === 0 ? '' : `: ${(demo.stdout + demo.stderr).slice(0, 400)}`}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\npack smoke test passed');
