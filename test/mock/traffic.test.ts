import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { recordDemo } from '../../src/demo/run.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { DEMO_DEVELOPERS } from '../../src/mock/traffic.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-traffic-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async (file: string): Promise<string[]> => (file.endsWith('.gz') ? gunzipSync(await readFile(file)).toString() : await readFile(file, 'utf8')).split('\n').filter(Boolean);

test('same seed gives byte-identical exported traces', async () => {
  const a = await recordDemo({ seed: 7, days: 2, traceFile: join(dir, 'a.ndjson') });
  const b = await recordDemo({ seed: 7, days: 2, traceFile: join(dir, 'b.ndjson') });
  await recordDemo({ seed: 8, days: 2, traceFile: join(dir, 'c.ndjson') });
  expect(a.requests).toBeGreaterThan(100);
  expect(await readFile(join(dir, 'a.ndjson'))).toEqual(await readFile(join(dir, 'b.ndjson')));
  expect(await readFile(join(dir, 'a.ndjson'))).not.toEqual(await readFile(join(dir, 'c.ndjson')));
  expect(b.requests).toBe(a.requests);
}, 120_000);

test('traffic has 8 developers in 3 teams, every request class, cache markers and one blocked secret, and no prompt text', async () => {
  const file = join(dir, 'shape.ndjson');
  await recordDemo({ seed: 1, days: 4, traceFile: file });
  const raw = await lines(file);
  const recs = raw.map((l) => JSON.parse(l) as TraceRecord).filter((r) => r.kind === 'request');
  expect(DEMO_DEVELOPERS).toHaveLength(8);
  expect(new Set(recs.map((r) => r.keyId)).size).toBe(8);
  expect(new Set(recs.map((r) => r.team))).toEqual(new Set(['platform', 'web', 'data']));
  const claude = recs.filter((r) => r.client.agent === 'claude-code');
  expect(new Set(claude.map((r) => r.attribution.requestClass))).toEqual(new Set(['main', 'subagent', 'compaction', 'auxiliary']));
  // A few Codex sessions on the Responses surface, through the codex route and the OpenAI provider.
  const codex = recs.filter((r) => r.surface === 'openai-responses');
  expect(codex.length).toBeGreaterThan(5);
  expect(new Set(codex.map((r) => r.client.agent))).toEqual(new Set(['codex']));
  expect(new Set(codex.map((r) => r.decision.route))).toEqual(new Set(['codex']));
  expect(codex.every((r) => r.decision.action === 'forward' && r.outcome.provider === 'openai' && (r.outcome.costMicroUsd ?? 0) > 0)).toBe(true);
  expect(codex.some((r) => (r.outcome.usage?.cacheRead ?? 0) > 0)).toBe(true);
  expect(codex.every((r) => r.features.maxOutputTokens === null && r.attribution.session !== null)).toBe(true);
  expect(recs.some((r) => r.attribution.parentAgent !== null)).toBe(true);
  expect(recs.some((r) => (r.outcome.usage?.cacheRead ?? 0) > 0)).toBe(true);
  expect(recs.some((r) => (r.outcome.usage?.cacheWrite5m ?? 0) > 0)).toBe(true);
  const secret = recs.filter((r) => r.decision.action === 'block' && (r.decision.reason === 'secret' || r.decision.reason === 'taint'));
  expect(secret.some((r) => r.decision.reason === 'secret')).toBe(true);
  expect(new Set(secret.map((r) => r.keyId)).size).toBe(1);
  expect(raw.join('\n')).not.toContain('AKIAIOSFODNN7EXAMPLE');
  expect(raw.join('\n')).not.toMatch(/ty_live_/);
}, 120_000);
