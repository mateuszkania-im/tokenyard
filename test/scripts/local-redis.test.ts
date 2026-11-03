import { expect, test } from 'vitest';
import { hostPort, isLoopbackRedisUrl, localRedisUrl, redisRunArgs } from '../../scripts/local-redis.mjs';

test('the local Redis publishes on a random loopback port only and requires a password', () => {
  const args = redisRunArgs('ty-redis-abc', 'pw123');
  const p = args.indexOf('-p');
  expect(args[p + 1]).toBe('127.0.0.1::6379');
  expect(args.filter((a) => a === '-p')).toHaveLength(1);
  expect(args.some((a) => a.startsWith('0.0.0.0') || a === '6379:6379')).toBe(false);
  expect(args).toContain('--rm');
  expect(args.slice(args.indexOf('redis:7'))).toEqual(['redis:7', 'redis-server', '--requirepass', 'pw123', '--save', '', '--appendonly', 'no']);
});

test('the host port is read back from docker port, loopback only', () => {
  expect(hostPort('127.0.0.1:55012\n')).toBe(55012);
  expect(() => hostPort('0.0.0.0:6379\n')).toThrow(/loopback/);
  expect(() => hostPort('')).toThrow();
  expect(localRedisUrl(55012, 'a/b c')).toBe('redis://:a%2Fb%20c@127.0.0.1:55012');
});

test('only a loopback Redis may be flushed by the benchmark', () => {
  expect(isLoopbackRedisUrl('redis://:pw@127.0.0.1:55012')).toBe(true);
  expect(isLoopbackRedisUrl('redis://localhost:6379')).toBe(true);
  expect(isLoopbackRedisUrl('redis://[::1]:6379')).toBe(true);
  expect(isLoopbackRedisUrl('redis://10.0.0.5:6379')).toBe(false);
  expect(isLoopbackRedisUrl('rediss://cache.example.com:6380')).toBe(false);
  expect(isLoopbackRedisUrl('not a url')).toBe(false);
});
