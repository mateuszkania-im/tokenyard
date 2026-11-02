import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

test('tokenyard --version prints package version', async () => {
  const { stdout } = await promisify(execFile)('node', ['bin/tokenyard.mjs', '--version']);
  expect(stdout.trim()).toBe(pkg.version);
});
