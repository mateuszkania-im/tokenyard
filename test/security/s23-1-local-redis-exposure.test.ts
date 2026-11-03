// S23-1 (coordinator finding, MEDIUM): the bench Redis container was published on all interfaces without a password
// (-p 6379:6379). Every test or bench Redis container is published on loopback with a random host port (read back
// with docker port), started with --requirepass, and shared through one helper; nothing in the repo publishes 6379.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { hostPort, isLoopbackRedisUrl, localRedisUrl, redisRunArgs } from '../../scripts/local-redis.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const text = (f: string): string => readFileSync(join(ROOT, f), 'utf8');

test('S23-1 the container is published on 127.0.0.1 with a random port and needs a password', () => {
  const args = redisRunArgs('ty-redis-abc', 'pw123');
  expect(args[args.indexOf('-p') + 1]).toBe('127.0.0.1::6379');
  expect(args.filter((a) => a === '-p')).toHaveLength(1);
  expect(args.some((a) => a.startsWith('0.0.0.0') || a === '6379:6379')).toBe(false);
  expect(args).toContain('--rm');
  expect(args).toContain('--requirepass');
});

test('S23-1 a port reported on a wildcard interface is refused and the URL carries the password', () => {
  expect(hostPort('127.0.0.1:55012\n')).toBe(55012);
  expect(() => hostPort('0.0.0.0:6379\n')).toThrow(/loopback/);
  expect(localRedisUrl(55012, 'a/b c')).toBe('redis://:a%2Fb%20c@127.0.0.1:55012');
});

test('S23-1 the benchmark flushes only a loopback Redis', () => {
  expect(isLoopbackRedisUrl('redis://10.0.0.5:6379')).toBe(false);
  expect(isLoopbackRedisUrl('rediss://cache.example.com:6380')).toBe(false);
  expect(isLoopbackRedisUrl('redis://:pw@127.0.0.1:55012')).toBe(true);
});

test('S23-1 no script, workflow or compose file publishes Redis on a wildcard interface', () => {
  for (const f of ['package.json', 'compose.yaml', 'bench/run.ts', '.github/workflows/ci.yml', 'deploy/gateway.sh']) {
    const t = text(f);
    expect(t, f).not.toMatch(/-p\s+6379:6379|"6379:6379"|0\.0\.0\.0:6379/);
    expect(t, f).not.toMatch(/(?:^|\s)-p\s+\d+:6379/m);
  }
  expect(text('compose.yaml')).not.toMatch(/image:\s*redis[\s\S]{0,200}ports:/);
});
