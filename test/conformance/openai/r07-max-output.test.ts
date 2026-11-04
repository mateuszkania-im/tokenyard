import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/handler.js';
import { createMemoryStore } from '../../../src/limits/memory-store.js';
import { codexHeaders, respBody, send, startOpenAIStack } from '../../helpers/conformance.js';
import { spyStore } from '../../helpers/store-spy.js';

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('R7 missing max_output_tokens reserves maxOutputTokens [https://developers.openai.com/api/reference/resources/responses]', async () => {
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ gw: { store: spy.store, onSettled: (o) => settled.push(o) } });
  // Every body is padded to the same length (a plain `user` field), so the bytes input bound is the same for each.
  const LEN = respBody({ max_output_tokens: 128000, user: 'u' }).length + 8;
  const padded = (extra: Record<string, unknown>): Buffer => {
    const base = respBody({ ...extra, user: '' }).length;
    return respBody({ ...extra, user: 'u'.repeat(LEN - base) });
  };
  const est = async (extra: Record<string, unknown>): Promise<number> => {
    const body = padded(extra);
    expect(body.length).toBe(LEN);
    const res = await send(stack!.gw.url, { path: '/v1/responses', headers: codexHeaders, body });
    expect(res.status).toBe(200);
    return spy.admits.at(-1)?.plan.reservations[0]?.estMicroUsd ?? -1;
  };
  // gpt-5.4-mini: maxOutputTokens 128,000 in the price table. 
  const missing = await est({});
  const explicitMax = await est({ max_output_tokens: 128000 });
  const small = await est({ max_output_tokens: 100000 });
  expect(missing).toBeGreaterThan(0);
  expect(missing).toBe(explicitMax);
  expect(small).toBeLessThan(missing);
  await expect.poll(() => settled.length).toBe(3);
  expect(settled[0]?.features.maxOutputTokens).toBeNull();
});
