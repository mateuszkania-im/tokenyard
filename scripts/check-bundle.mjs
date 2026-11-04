import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOptions } from '../esbuild.config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tokenyard-bundle-'));
try {
  const out = join(dir, 'tokenyard.mjs');
  await build(buildOptions(out));
  const fresh = readFileSync(out);
  let committed;
  try {
    committed = readFileSync('bin/tokenyard.mjs');
  } catch {
    console.error('bin/tokenyard.mjs is missing; run npm run build');
    process.exit(1);
  }
  if (!fresh.equals(committed)) {
    console.error('bin/tokenyard.mjs is stale; run npm run build and commit it');
    process.exit(1);
  }
  console.log('bundle is up to date');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
