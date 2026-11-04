import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { type OpenAIMockServer, startOpenAIMock } from '../../src/mock/openai.js';

let mock: OpenAIMockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function post(url: string, body: string): Promise<{ status: number; cached: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL('/v1/responses', url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cached: (JSON.parse(text) as { usage: { input_tokens_details: { cached_tokens: number } } }).usage.input_tokens_details.cached_tokens }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const body = (key: string): string => JSON.stringify({ model: 'gpt-5.5', input: 'x'.repeat(4_000), stream: false, prompt_cache_key: key });

test('V2 leak: keepReceived bounds the requests the OpenAI mock keeps (the CLI mock keeps none)', async () => {
  mock = await startOpenAIMock({ keepReceived: 1 });
  for (const k of ['a', 'b', 'c']) expect((await post(mock.url, body(k))).status).toBe(200);
  expect(mock.received.map((r) => JSON.parse(r.body.toString('utf8')).prompt_cache_key)).toEqual(['c']);
});

test('V2 leak: the prompt cache keeps a bounded number of cache keys, the most recently used', async () => {
  mock = await startOpenAIMock({ keepReceived: 0, maxCacheKeys: 2 });
  for (const k of ['a', 'b', 'a', 'c']) await post(mock.url, body(k));
  // b was the least recently used when c came in, so it is gone; a and c still read their cache.
  expect((await post(mock.url, body('b'))).cached).toBe(0);
  expect((await post(mock.url, body('c'))).cached).toBeGreaterThan(0);
});
