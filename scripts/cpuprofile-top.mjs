#!/usr/bin/env node
// Top self-time functions of a V8 .cpuprofile (from `node --cpu-prof`), for docs/benchmarks.md.
//   node scripts/cpuprofile-top.mjs <file.cpuprofile> [count]
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Self time per function (name, file and line), in ms, sorted descending, with its share of all sampled time. */
export function topSelf(profile, count = 20, root = process.cwd()) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = profile.timeDeltas ?? [];
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const dt = (deltas[i + 1] ?? 0) / 1000; // the time until the next sample; the last one has none
    if (!node) continue;
    total += dt;
    const f = node.callFrame;
    // slash-separated on every platform (relative gives backslashes on Windows)
    let file = f.url.startsWith('file://') ? relative(root, fileURLToPath(f.url)).split(sep).join('/') : f.url;
    if (file.includes('node_modules/')) file = file.slice(file.lastIndexOf('node_modules/'));
    const key = `${f.functionName || '(anonymous)'} ${file}${file ? `:${f.lineNumber + 1}` : ''}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, count);
  return { totalMs: Math.round(total), rows: rows.map(([fn, ms]) => ({ fn, ms: Math.round(ms), pct: Math.round((ms / total) * 1000) / 10 })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, count] = process.argv.slice(2);
  if (!file) {
    console.error('usage: cpuprofile-top.mjs <file.cpuprofile> [count]');
    process.exit(2);
  }
  const t = topSelf(JSON.parse(readFileSync(file, 'utf8')), Number(count ?? 20));
  console.log(`sampled ${t.totalMs} ms`);
  for (const r of t.rows) console.log(`${String(r.pct).padStart(5)}%  ${String(r.ms).padStart(6)} ms  ${r.fn}`);
}
