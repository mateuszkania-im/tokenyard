// B6 (security review B): trace files and their directories were created world-readable (0644 / 0755 under the usual
// umask), so any local user read tenant, team, route and attribution names and costs. Traces, exports, HTML reports,
// replay JSON and the last-known-good policy file are now created 0600 inside directories created 0700, and an existing
// trace or export file is narrowed to 0600 when it is written again.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { exportTraces } from '../../src/ledger/export.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { TraceWriter } from '../../src/ledger/writer.js';
import { writeLkg } from '../../src/policy-loader/lkg.js';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'tokenyard.mjs');
const posix = process.platform !== 'win32';
const mode = (p: string): number => statSync(p).mode & 0o777;
const T0 = Date.parse('2026-11-02T10:00:00Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ty-b6-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(): Omit<TraceRecord, 'instance' | 'seq'> {
  return {
    v: 1, kind: 'request', id: 'r1', ts: new Date(T0).toISOString(), tenant: 'acme', team: 'web', keyId: 'key_1', traffic: 'coding-agent', billing: 'api', surface: 'anthropic-messages',
    client: { agent: 'claude-code', version: null },
    attribution: { session: null, agent: null, parentAgent: null, promptId: null, requestClass: 'main', agentType: null, repo: 'r', branch: null, ticket: null, feature: null },
    features: { model: 'claude-haiku-5-5', stream: false, inputTokensBound: 1, boundKind: 'bytes', maxOutputTokens: 1, serverTools: [], toolCount: 0, thinking: false, bodyBytes: 1, prefixHash: null, contextCompacted: false },
    guardrail: { hits: [] }, policy: { revision: 'r' },
    decision: { route: 'x', action: 'forward', reason: null, chain: [], reservedMicroUsd: 0, boundAssumed: false, taintUnchecked: false, audit: [] },
    outcome: { provider: null, upstreamModel: null, attempts: 1, cacheColdRisk: false, status: 200, errorClass: null, midStreamError: null, ttfbMs: 1, totalMs: 1, addedTtfbMs: 0, usage: null, usageSource: 'none', costMicroUsd: 1, costBasis: 'billed', priceTable: 't', aborted: false, settledBy: 'request', overrun: false },
  };
}

async function writeTraces(): Promise<string> {
  const traces = join(dir, 'traces');
  const w = new TraceWriter({ dir: traces, instanceId: 'i1', queueMax: 10, clock: () => T0 });
  w.write(record());
  await w.close();
  return traces;
}

test.skipIf(!posix)('B6 trace files are 0600 and every directory the writer creates is 0700', async () => {
  const traces = await writeTraces();
  const find = spawnSync('find', [traces], { encoding: 'utf8' }).stdout.trim().split('\n');
  const files = find.filter((p) => statSync(p).isFile());
  const dirs = find.filter((p) => statSync(p).isDirectory());
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(mode(f), f).toBe(0o600);
  for (const d of dirs) expect(mode(d), d).toBe(0o700);
});

test.skipIf(!posix)('B6 an existing world-readable trace file is narrowed to 0600 on the next write', async () => {
  const traces = await writeTraces();
  const file = spawnSync('find', [traces, '-type', 'f'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] as string;
  chmodSync(file, 0o644);
  const w = new TraceWriter({ dir: traces, instanceId: 'i1', queueMax: 10, clock: () => T0 });
  w.write(record());
  await w.close();
  expect(mode(file)).toBe(0o600);
});

test.skipIf(!posix)('B6 exports (plain and anonymized) and HTML reports are 0600; a new output directory is 0700', async () => {
  const traces = await writeTraces();
  const out = join(dir, 'out', 'export.ndjson.gz');
  await exportTraces({ dir: traces, sinceMs: T0 - 3_600_000, untilMs: T0 + 3_600_000, out });
  expect(mode(out)).toBe(0o600);
  expect(mode(join(dir, 'out'))).toBe(0o700);
  const anon = join(dir, 'anon.ndjson');
  await exportTraces({ dir: traces, sinceMs: T0 - 3_600_000, untilMs: T0 + 3_600_000, out: anon, anonymizeSalt: 'one-off-salt' });
  expect(mode(anon)).toBe(0o600);
  // An export file left world-readable by an older version is narrowed when overwritten.
  chmodSync(out, 0o644);
  await exportTraces({ dir: traces, sinceMs: T0 - 3_600_000, untilMs: T0 + 3_600_000, out });
  expect(mode(out)).toBe(0o600);
  const html = join(dir, 'reports', 'r.html');
  const r = spawnSync(process.execPath, [BIN, 'report', '--traces', out, '--since', '2026-11-01T00:00:00Z', '--until', '2026-11-03T00:00:00Z', '--html', html], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(mode(html)).toBe(0o600);
  expect(mode(join(dir, 'reports'))).toBe(0o700);
});

test.skipIf(!posix)('B6 the last-known-good file is 0600 in a state directory created 0700', async () => {
  const state = join(dir, 'state');
  await writeLkg(state, '{"x":1}');
  expect(mode(state)).toBe(0o700);
  expect(mode(join(state, 'last-known-good.json'))).toBe(0o600);
});
