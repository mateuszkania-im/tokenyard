// S10-1 (coordinator finding, Task 10, MEDIUM): rewriteModel must be byte-faithful (only the bytes of the top-level
// "model" string change, content-length recomputed), must price the reservation at the model the upstream will serve,
// and on a coding-agent route it needs allowBodyRewrite and a reason (E_BODY_REWRITE).
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { compilePolicy, PolicyInvalidError } from '../../src/policy/compile.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { HEAD, source } from '../policy/helpers.js';
import { closeAll, closers, gw } from './common.js';

afterEach(closeAll);

const RAW = '{ "max_tokens": 64,\n "metadata": {"model": "inner"},\n "model" :  "claude-opus-5-5" , "messages":[{"role":"user","content":"\\"model\\": x"}] }';

test('S10-1 upstream gets the served model with every other byte unchanged, content-length recomputed', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gw(testPolicy({ upstream: mock.url, rewriteModel: 'claude-haiku-5-5' }));
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: RAW });
  expect(r.status).toBe(200);
  const got = mock.received[0];
  expect(got?.body.toString('utf8')).toBe(RAW.replace('"claude-opus-5-5"', '"claude-haiku-5-5"'));
  expect(got?.headers['content-length']).toBe(String(Buffer.byteLength(got?.body.toString('utf8') ?? '')));
});

test('S10-1 the reservation is priced at the served model, not the requested one', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const plain = await gw(testPolicy({ upstream: mock.url }));
  const rewriting = await gw(testPolicy({ upstream: mock.url, rewriteModel: 'claude-haiku-5-5' }));
  const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  await send(plain.url, { path: '/v1/messages', headers: authHeaders, body });
  await send(rewriting.url, { path: '/v1/messages', headers: authHeaders, body });
  await expect.poll(() => plain.outcomes.length + rewriting.outcomes.length).toBe(2);
  const opus = plain.outcomes[0]?.reservedMicroUsd ?? 0;
  const haiku = rewriting.outcomes[0]?.reservedMicroUsd ?? 0;
  expect(haiku).toBeGreaterThan(0);
  expect(haiku).toBeLessThan(opus);
});

test('S10-1 a rewrite on coding-agent traffic without allowBodyRewrite and a reason is a policy error', () => {
  const yaml = (extra: string): string => `${HEAD}routes:\n  - { name: cheap, match: { traffic: coding-agent }, chain: [a], rewriteModel: claude-haiku-5-5${extra} }\n`;
  expect(() => compilePolicy(source(yaml('')), 'r', { experimentalSubscription: false })).toThrow(PolicyInvalidError);
  expect(() => compilePolicy(source(yaml(', allowBodyRewrite: true')), 'r', { experimentalSubscription: false })).toThrow(PolicyInvalidError);
  expect(() => compilePolicy(source(yaml(', allowBodyRewrite: true, because: auxiliary calls')), 'r', { experimentalSubscription: false })).not.toThrow();
});
