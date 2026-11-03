import { expect, test } from 'vitest';
import { extractCredential, hashKey } from '../../src/edge/auth.js';
import { anthropicError } from '../../src/edge/errors.js';
import { clientHeaders, upstreamHeaders } from '../../src/edge/headers.js';
import { matchRoute } from '../../src/edge/paths.js';

test('matchRoute keeps the query, strips the base path and accepts mounts without /v1', () => {
  expect(matchRoute('POST', '/v1/messages?beta=true', null)).toEqual({ surface: 'anthropic-messages', pathAndQuery: '/v1/messages?beta=true' });
  expect(matchRoute('POST', '/v1/messages/count_tokens', null)).toEqual({ surface: 'anthropic-count-tokens', pathAndQuery: '/v1/messages/count_tokens' });
  expect(matchRoute('GET', '/v1/models?limit=1000', null)).toEqual({ surface: 'models', pathAndQuery: '/v1/models?limit=1000' });
  expect(matchRoute('HEAD', '/api/hello', null)).toEqual({ surface: 'hello', pathAndQuery: '/api/hello' });
  expect(matchRoute('POST', '/gw/v1/messages?beta=true', '/gw')).toEqual({ surface: 'anthropic-messages', pathAndQuery: '/v1/messages?beta=true' });
  expect(matchRoute('POST', '/gw/v1/messages', '/gw/')).toEqual({ surface: 'anthropic-messages', pathAndQuery: '/v1/messages' });
  expect(matchRoute('POST', '/gw/v1/messages?beta=true', '/gw/v1')).toEqual({ surface: 'anthropic-messages', pathAndQuery: '/v1/messages?beta=true' });
  expect(matchRoute('POST', '/messages', null)).toEqual({ surface: 'anthropic-messages', pathAndQuery: '/v1/messages' });
  expect(matchRoute('POST', '/gwx/v1/messages', '/gw')).toBeNull();
  expect(matchRoute('POST', '/v1/messages', '/gw')).toBeNull();
  expect(matchRoute('GET', '/v1/messages', null)).toBeNull();
  expect(matchRoute('POST', '/v1/other', null)).toBeNull();
});

test('extractCredential prefers x-tokenyard-key, then Bearer, then x-api-key', () => {
  expect(extractCredential({ 'x-tokenyard-key': 'a', authorization: 'Bearer b', 'x-api-key': 'c' })).toEqual({ source: 'x-tokenyard-key', value: 'a' });
  expect(extractCredential({ authorization: 'bearer b', 'x-api-key': 'c' })).toEqual({ source: 'bearer', value: 'b' });
  expect(extractCredential({ authorization: 'Basic zz', 'x-api-key': 'c' })).toEqual({ source: 'x-api-key', value: 'c' });
  expect(extractCredential({})).toBeNull();
  expect(hashKey('ty_live_dev')).toMatch(/^[0-9a-f]{64}$/);
});

test('upstreamHeaders: passthrough mode keeps Authorization and drops x-tokenyard-*', () => {
  const h = upstreamHeaders(
    { authorization: 'Bearer oauth', 'x-tokenyard-key': 'k', 'content-length': '10', expect: '100-continue', 'anthropic-beta': 'a' },
    { mode: 'passthrough', credential: null, host: 'up.example:443' },
  );
  expect(h).toEqual({ authorization: 'Bearer oauth', 'anthropic-beta': 'a', host: 'up.example:443', 'accept-encoding': 'identity' });
});

test('upstreamHeaders: API mode with an OpenAI-style credential', () => {
  const h = upstreamHeaders(
    { authorization: 'Bearer ty', 'x-api-key': 'ty2' },
    { mode: 'api', credential: { header: 'authorization', value: 'Bearer sk' }, host: 'h' },
  );
  expect(h).toEqual({ authorization: 'Bearer sk', host: 'h', 'accept-encoding': 'identity' });
});

test('clientHeaders drops hop-by-hop and upstream x-tokenyard-*, keeps the rest', () => {
  const h = clientHeaders(
    { connection: 'keep-alive', 'transfer-encoding': 'chunked', 'x-tokenyard-request-id': 'spoof', 'retry-after': '3', 'set-cookie': ['a', 'b'] },
    { 'x-tokenyard-request-id': 'r1', 'X-Accel-Buffering': 'no' },
    'api',
  );
  expect(h).toEqual({ 'retry-after': '3', 'set-cookie': ['a', 'b'], 'x-tokenyard-request-id': 'r1', 'X-Accel-Buffering': 'no' });
});

test('anthropicError builds the envelope with integer retry-after', () => {
  const e = anthropicError(429, 'rate_limit_error', 'slow down', 2.7, 'r1');
  expect(e.status).toBe(429);
  expect(e.headers['retry-after']).toBe('3');
  expect(e.headers['x-tokenyard-request-id']).toBe('r1');
  expect(JSON.parse(e.body.toString())).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'tokenyard: slow down' } });
  expect(anthropicError(400, 'invalid_request_error', 'x', null, 'r').headers['retry-after']).toBeUndefined();
});
