import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERN = /sk-(ant|proj)-[A-Za-z0-9_-]{20,}/g;
// Only the documented fake test canary prefix is exempt.
const CANARY = /^sk-ant-test-CANARY/;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const tarball = process.argv[2];
if (tarball) files.push(tarball);

const offenders = [];
for (const file of files) {
  let data;
  try {
    data = readFileSync(file).toString('latin1');
  } catch {
    continue;
  }
  if ((data.match(PATTERN) ?? []).some((m) => !CANARY.test(m))) offenders.push(file);
}
if (offenders.length > 0) {
  for (const f of offenders) console.error(`possible API key in: ${f}`);
  process.exit(1);
}
console.log(`no secrets found in ${files.length} files`);
