// Spec 12.3 item 5: replay throughput on 1 million synthetic trace records. The records are the committed demo traces
// (examples/traces/demo.ndjson.gz) repeated week after week with fresh ids and sessions, written as one gzipped export;
// the timed part is what `tokenyard policy replay` does with such a file: read, parse, simulate base and head.
//   npx tsx bench/replay.ts [records]
import { fork } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { DEMO_CREDENTIAL_ENV, demoPolicies } from '../src/demo/policy.js';
import type { ManifestRecord, TraceRecord } from '../src/ledger/record.js';
import { readLedger } from '../src/ledger/reader.js';
import { replay } from '../src/replay/engine.js';
import { ROOT, round } from './lib.js';

const WEEK_MS = 7 * 86_400_000;
export const DEMO_TRACES = join(ROOT, 'examples', 'traces', 'demo.ndjson.gz');

export async function demoRecords(): Promise<{ manifest: ManifestRecord; records: TraceRecord[] }> {
  let manifest: ManifestRecord | null = null;
  const records: TraceRecord[] = [];
  for await (const l of readLedger([DEMO_TRACES])) {
    if (l.kind === 'manifest') manifest = l;
    else if (l.kind === 'request') records.push(l);
  }
  if (!manifest) throw new Error(`${DEMO_TRACES} has no manifest`);
  return { manifest, records };
}

const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** Writes `n` records: copy k of the demo week moved k weeks later, ids and session pseudonyms suffixed with k. */
export async function writeSynthetic(n: number, file: string): Promise<void> {
  const { manifest, records } = await demoRecords();
  const copies = Math.ceil(n / records.length);
  const gz = createGzip({ level: 1 });
  const out = createWriteStream(file);
  gz.pipe(out);
  const write = (line: object): Promise<void> | void => {
    if (!gz.write(`${JSON.stringify(line)}\n`)) return new Promise((r) => gz.once('drain', () => r()));
  };
  const span = (copies - 1) * WEEK_MS;
  const inst = manifest.instances[0] as ManifestRecord['instances'][number];
  await write({ ...manifest, until: shift(manifest.until, span), instances: [{ ...inst, lastTs: shift(inst.lastTs, span), records: n, seqGaps: 0, hoursWithoutFile: [] }] });
  let written = 0;
  for (let k = 0; k < copies && written < n; k++) {
    for (const r of records) {
      if (written === n) break;
      const a = r.attribution;
      await write({
        ...r,
        id: `${r.id}.${k}`,
        ts: shift(r.ts, k * WEEK_MS),
        seq: written + 1,
        attribution: { ...a, session: a.session === null ? null : `${a.session}.${k}`, promptId: a.promptId === null ? null : `${a.promptId}.${k}` },
      });
      written++;
    }
  }
  gz.end();
  await new Promise<void>((r) => out.once('finish', () => r()));
}

/** Child side: one timed replay of the file against the demo's base and head policies. */
async function timedReplay(file: string): Promise<{ seconds: number; requests: number; agreement: number }> {
  process.env[DEMO_CREDENTIAL_ENV] = 'bench-not-a-key';
  const { base, head } = demoPolicies('http://127.0.0.1:9');
  const t0 = performance.now();
  const r = await replay({ base, head, traces: readLedger([file]), sinceMs: null, tenant: null });
  return { seconds: (performance.now() - t0) / 1000, requests: r.requests, agreement: r.fidelity.agreement };
}

export async function benchReplay(n = 1_000_000): Promise<{ records: number; seconds: number; recordsPerSecond: number; fileMb: number; fidelityAgreement: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'tokenyard-bench-replay-'));
  try {
    const file = join(dir, 'synthetic.ndjson.gz');
    await writeSynthetic(n, file);
    const { size } = await import('node:fs/promises').then((f) => f.stat(file));
    // Its own process with a large heap: replay holds the whole window in memory (spec 9.2).
    const child = fork(join(import.meta.dirname, 'replay.ts'), ['child', file], { execArgv: ['--import', 'tsx', '--max-old-space-size=8192'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const r = await new Promise<{ seconds: number; requests: number; agreement: number }>((resolve, reject) => {
      child.once('message', (m) => resolve(m as { seconds: number; requests: number; agreement: number }));
      child.once('exit', (code) => reject(new Error(`replay child exited with ${code}`)));
    });
    child.kill();
    if (r.requests !== n) throw new Error(`replay saw ${r.requests} records, not ${n}`);
    return { records: n, seconds: round(r.seconds, 1), recordsPerSecond: Math.round(n / r.seconds), fileMb: round(size / 1024 / 1024, 1), fidelityAgreement: r.agreement };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'child') process.send?.(await timedReplay(process.argv[3] as string));
  else console.log(await benchReplay(Number(process.argv[2] ?? 1_000_000)));
}
