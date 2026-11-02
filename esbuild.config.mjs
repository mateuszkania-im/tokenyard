import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as __tyCreateRequire } from 'node:module';",
  'const require = __tyCreateRequire(import.meta.url);',
].join('\n');

export function buildOptions(outfile) {
  return {
    entryPoints: ['src/cli.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: banner },
    legalComments: 'none',
    logLevel: 'warning',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(buildOptions('bin/tokenyard.mjs'));
}
