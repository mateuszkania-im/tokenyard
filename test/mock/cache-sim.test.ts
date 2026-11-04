import { expect, test } from 'vitest';
import { CacheSimulator } from '../../src/mock/cache-sim.js';
import { buildAgentSession } from '../../src/mock/session-fixture.js';
import { mulberry32 } from '../../src/mock/scenarios.js';

const MODEL = 'claude-opus-5-5';
const session = buildAgentSession(3, 7);

test('second identical prefix within 5 minutes is a cache read', () => {
  const sim = new CacheSimulator();
  const b = session[0] as Buffer;
  expect(sim.usageFor(b, MODEL, 0).cacheRead).toBe(0);
  expect(sim.usageFor(b, MODEL, 60_000).cacheRead).toBeGreaterThan(0);
});

test('first request writes the cache and the total token count is conserved', () => {
  const sim = new CacheSimulator();
  const u = sim.usageFor(session[0] as Buffer, MODEL, 0);
  expect(u.cacheWrite5m).toBeGreaterThan(0);
  expect(u.cacheRead).toBe(0);
  const again = sim.usageFor(session[0] as Buffer, MODEL, 1000);
  expect(again.cacheRead + again.input + again.cacheWrite5m + again.cacheWrite1h).toBe(
    u.cacheRead + u.input + u.cacheWrite5m + u.cacheWrite1h,
  );
});

test('a growing session reads the previous turn prefix', () => {
  const sim = new CacheSimulator();
  const u0 = sim.usageFor(session[0] as Buffer, MODEL, 0);
  const u1 = sim.usageFor(session[1] as Buffer, MODEL, 10_000);
  expect(u1.cacheRead).toBe(u0.cacheRead + u0.cacheWrite5m + u0.cacheWrite1h);
});

test('5m entries expire after five minutes', () => {
  const sim = new CacheSimulator();
  const b = session[0] as Buffer;
  sim.usageFor(b, MODEL, 0);
  expect(sim.usageFor(b, MODEL, 301_000).cacheRead).toBe(0);
});

test('a read refreshes the ttl', () => {
  const sim = new CacheSimulator();
  const b = session[0] as Buffer;
  sim.usageFor(b, MODEL, 0);
  sim.usageFor(b, MODEL, 200_000);
  expect(sim.usageFor(b, MODEL, 450_000).cacheRead).toBeGreaterThan(0);
});

const mixed = (): string =>
  JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    system: [{ type: 'text', text: 'S'.repeat(4000), cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'M'.repeat(2000), cache_control: { type: 'ephemeral' } }],
      },
    ],
  });

test('ttl 1h breakpoints survive 30 minutes, 5m ones do not', () => {
  const sim = new CacheSimulator();
  const first = sim.usageFor(mixed(), MODEL, 0);
  expect(first.cacheWrite1h).toBeGreaterThanOrEqual(1000);
  expect(first.cacheWrite5m).toBeGreaterThanOrEqual(500);
  const later = sim.usageFor(mixed(), MODEL, 30 * 60_000);
  expect(later.cacheRead).toBe(first.cacheWrite1h);
  expect(later.cacheWrite5m).toBe(first.cacheWrite5m);
  expect(later.cacheWrite1h).toBe(0);
});

test('flattening system to a string changes the prefix and loses the cache', () => {
  const sim = new CacheSimulator();
  const body = JSON.parse((session[0] as Buffer).toString('utf8'));
  sim.usageFor(body, MODEL, 0);
  const flat = {
    ...body,
    system: body.system.map((b: { text: string }) => b.text).join('\n'),
  };
  expect(sim.usageFor(flat, MODEL, 1000).cacheRead).toBe(0);
});

test('cache is per model and per workspace', () => {
  const sim = new CacheSimulator('a');
  const b = session[0] as Buffer;
  sim.usageFor(b, MODEL, 0);
  expect(sim.usageFor(b, 'claude-sonnet-5-5', 1000).cacheRead).toBe(0);
  const other = new CacheSimulator('b');
  expect(other.usageFor(b, MODEL, 1000).cacheRead).toBe(0);
});

test('bodies without breakpoints are all fresh input', () => {
  const sim = new CacheSimulator();
  const body = { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(400) }] };
  const u = sim.usageFor(body, MODEL, 0);
  expect(u.input).toBeGreaterThanOrEqual(100);
  expect(u).toEqual({ input: u.input, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
});

test('mulberry32 is seeded and stays in [0,1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 5 }, () => a());
  expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
  for (const x of xs) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1);
  }
});

test('V2 leak: expired entries are dropped, so a long-running mock does not keep every prefix it ever saw', () => {
  const sim = new CacheSimulator();
  const size = (): number => (sim as unknown as { entries: Map<string, unknown> }).entries.size;
  // A new 5-minute breakpoint every minute for 1,000 minutes: at most the last few are live.
  for (let i = 0; i < 1_000; i++) {
    const body = { system: [{ type: 'text', text: `prompt ${i}`, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hi' }] };
    sim.usageFor(body, MODEL, i * 60_000);
  }
  expect(size()).toBeLessThanOrEqual(10);
});
