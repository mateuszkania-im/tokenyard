// B7 (security review B): `traces export --anonymize` fell back to TOKENYARD_TRACE_SALT, the gateway's long-lived salt
// (every replica's environment, a public default in the compose demo), so its holder reversed tenant, team and repo
// pseudonyms by dictionary, and every export made with it linked to every other. Now the export salt is a one-off:
// TOKENYARD_EXPORT_SALT or --salt-file, else a random salt that is never stored; a salt equal to the trace salt is refused.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { saltedPseudonyms } from '../../src/ledger/anonymize.js';
import { TraceWriter } from '../../src/ledger/writer.js';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'tokenyard.mjs');
const TRACE_SALT = 'demo-trace-salt-not-a-secret';
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ty-b7-'));
  const now = Date.now();
  const w = new TraceWriter({ dir: join(dir, 'traces'), instanceId: 'i1', queueMax: 10, clock: () => now });
  w.write({
    v: 1, kind: 'request', id: 'r1', ts: new Date(now - 1000).toISOString(), tenant: 'CANARYCORP', team: 'payments', keyId: 'key_1', traffic: 'coding-agent', billing: 'api', surface: 'anthropic-messages',
    client: { agent: 'claude-code', version: null },
    attribution: { session: null, agent: null, parentAgent: null, promptId: null, requestClass: 'main', agentType: null, repo: 'CANARY-internal-repo', branch: 'main', ticket: null, feature: null },
    features: { model: 'claude-haiku-5-5', stream: false, inputTokensBound: 1, boundKind: 'bytes', maxOutputTokens: 1, serverTools: [], toolCount: 0, thinking: false, bodyBytes: 1, prefixHash: null, contextCompacted: false },
    guardrail: { hits: [] }, policy: { revision: 'r' },
    decision: { route: 'x', action: 'forward', reason: null, chain: [], reservedMicroUsd: 0, boundAssumed: false, taintUnchecked: false, audit: [] },
    outcome: { provider: null, upstreamModel: null, attempts: 1, cacheColdRisk: false, status: 200, errorClass: null, midStreamError: null, ttfbMs: 1, totalMs: 1, addedTtfbMs: 0, usage: null, usageSource: 'none', costMicroUsd: 0, costBasis: 'billed', priceTable: 't', aborted: false, settledBy: 'request', overrun: false },
  });
  await w.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function exportWith(env: Record<string, string>, extra: string[] = [], out = join(dir, 'anon.ndjson.gz')) {
  const base = { ...process.env };
  delete base.TOKENYARD_TRACE_SALT;
  delete base.TOKENYARD_EXPORT_SALT;
  const r = spawnSync(process.execPath, [BIN, 'traces', 'export', '--trace-dir', join(dir, 'traces'), '--out', out, '--since', '1d', '--anonymize', ...extra], { env: { ...base, ...env }, encoding: 'utf8' });
  return { ...r, text: r.status === 0 ? gunzipSync(readFileSync(out)).toString('utf8') : '' };
}

const recovered = (text: string, salt: string): string[] => {
  const p = saltedPseudonyms(salt);
  return [['tenant', 'CANARYCORP'], ['repo', 'CANARY-internal-repo']].filter(([k, v]) => text.includes(p(k as 'tenant', v as string))).map(([k]) => k as string);
};

test('B7 with only TOKENYARD_TRACE_SALT set, --anonymize uses a random one-off salt: the trace salt reverses nothing', () => {
  const a = exportWith({ TOKENYARD_TRACE_SALT: TRACE_SALT });
  expect(a.status, a.stderr).toBe(0);
  expect(a.stderr).toMatch(/random one-off salt/);
  expect(a.text).not.toContain('CANARY');
  expect(recovered(a.text, TRACE_SALT)).toEqual([]);
  // Two exports do not link to each other.
  const b = exportWith({ TOKENYARD_TRACE_SALT: TRACE_SALT }, [], join(dir, 'b.ndjson.gz'));
  expect(b.text.split('\n')[1]).not.toBe(a.text.split('\n')[1]);
});

test('B7 an export salt equal to the trace salt is refused', () => {
  const r = exportWith({ TOKENYARD_TRACE_SALT: TRACE_SALT, TOKENYARD_EXPORT_SALT: TRACE_SALT });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/must differ from the trace salt/);
  writeFileSync(join(dir, 'salt'), `${TRACE_SALT}\n`);
  expect(exportWith({ TOKENYARD_TRACE_SALT: TRACE_SALT }, ['--salt-file', join(dir, 'salt')]).status).toBe(1);
});

test('B7 an explicit one-off salt (env or file) gives the same pseudonyms each time', () => {
  writeFileSync(join(dir, 'salt'), 'one-off-export-salt\n');
  const a = exportWith({ TOKENYARD_TRACE_SALT: TRACE_SALT }, ['--salt-file', join(dir, 'salt')]);
  const b = exportWith({ TOKENYARD_EXPORT_SALT: 'one-off-export-salt' }, [], join(dir, 'b.ndjson.gz'));
  expect(a.status, a.stderr).toBe(0);
  expect(recovered(a.text, 'one-off-export-salt')).toEqual(['tenant', 'repo']);
  expect(b.text.split('\n')[1]).toBe(a.text.split('\n')[1]);
});

test('B7r the equality check also covers a trace salt given with --trace-salt-file', () => {
  writeFileSync(join(dir, 'trace-salt'), 'gateway-salt-from-file\n');
  writeFileSync(join(dir, 'export-salt'), 'gateway-salt-from-file');
  const viaEnv = exportWith({ TOKENYARD_EXPORT_SALT: 'gateway-salt-from-file' }, ['--trace-salt-file', join(dir, 'trace-salt')]);
  expect(viaEnv.status).toBe(1);
  expect(viaEnv.stderr).toMatch(/must differ from the trace salt/);
  expect(exportWith({}, ['--trace-salt-file', join(dir, 'trace-salt'), '--salt-file', join(dir, 'export-salt')]).status).toBe(1);
  // A different one-off salt with the trace salt file given is fine.
  expect(exportWith({ TOKENYARD_EXPORT_SALT: 'one-off' }, ['--trace-salt-file', join(dir, 'trace-salt')]).status).toBe(0);
});
