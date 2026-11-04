import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { hashKey } from '../src/edge/auth.js';
import { DEMO_DEVELOPERS } from '../src/mock/traffic.js';
import { demoKey } from '../src/demo/policy.js';

const run = promisify(execFile);

test('compose demo policies pass policy check and hold the public demo keys', async () => {
  for (const d of ['base', 'head']) {
    const { stdout } = await run('node', ['bin/tokenyard.mjs', 'policy', 'check', `deploy/demo/${d}`]);
    expect(stdout).toContain('0 errors');
    const keys = await readFile(`deploy/demo/${d}/keys.yaml`, 'utf8');
    for (const dev of DEMO_DEVELOPERS) expect(keys).toContain(hashKey(demoKey(dev.name)));
  }
});

test('the docker build context is an allow-list that keeps secrets and local state out', async () => {
  const lines = (await readFile('.dockerignore', 'utf8')).split('\n').map((l) => l.trim());
  expect(lines[lines.findIndex((l) => !l.startsWith('#') && l !== '')]).toBe('*');
  for (const p of ['**/.env', '**/.env.*', '**/.live', '**/node_modules', '**/.superpowers', '**/traces']) expect(lines).toContain(p);
  expect(lines.filter((l) => l.startsWith('!'))).toEqual(['!bin/tokenyard.mjs', '!deploy/']);
});

test('report --html writes one self-contained file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ty-html-'));
  try {
    const out = join(dir, 'report.html');
    await run('node', ['bin/tokenyard.mjs', 'report', '--traces', 'examples/traces/demo.ndjson.gz', '--since', '2026-10-01T00:00:00Z', '--until', '2026-12-01T00:00:00Z', '--by', 'team', '--html', out]);
    const html = await readFile(out, 'utf8');
    for (const team of ['platform', 'web', 'data']) expect(html).toContain(`<td>${team}</td>`);
    expect(html).not.toMatch(/<script|https?:|<link|@import/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
