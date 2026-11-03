// V4 fuzz: attribution headers are client input that reaches traces, metrics, reports and PR comments. For any
// headers, `readAttribution` returns exactly its known fields, each null or printable ASCII of at most 128 characters,
// and a hostile header name (`__proto__`, `constructor`) changes nothing; through a real gateway, raw requests with
// such names and with non-ASCII bytes give bounded trace labels and never crash the process.
import { connect } from 'node:net';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readAttribution } from '../../src/edge/attribution.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { MAX_LABEL_LENGTH } from '../../src/report/sanitize.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';
import { startRawUpstream } from '../helpers/conformance.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

const FIELDS = ['session', 'agent', 'parentAgent', 'requestClass', 'agentType', 'promptId', 'repo', 'branch', 'ticket', 'feature'];
const NAMES = ['x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id', 'x-claude-code-request-class', 'x-claude-code-agent-type', 'x-claude-code-prompt-id', 'x-tokenyard-repo', 'x-tokenyard-branch', 'x-tokenyard-ticket', 'x-tokenyard-feature', 'session_id', 'session-id'];
const HOSTILE = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'sanitized', 'x-claude-code-__proto__'];
const SURFACES = ['anthropic-messages', 'anthropic-count-tokens', 'openai-responses', 'openai-chat'] as const;

const bounded = (v: unknown): boolean => v === null || (typeof v === 'string' && v.length > 0 && v.length <= MAX_LABEL_LENGTH && /^[\x20-\x7e]+$/.test(v));
const headerValue = fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: 'grapheme', maxLength: 40 }), fc.constantFrom('', '   ', 'main', '\u0000\u001b[31m', 'a'.repeat(129), '../../etc/passwd'));

test('fuzz: readAttribution returns only its fields, each null or bounded printable ASCII, whatever the headers', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.constantFrom(...NAMES, ...HOSTILE), fc.oneof(headerValue, fc.array(headerValue, { maxLength: 3 }))), { maxLength: 14 }),
      fc.constantFrom(...SURFACES),
      fc.boolean(),
      (pairs, surface, nullProto) => {
        const h: Record<string, string | string[]> = nullProto ? Object.create(null) : {};
        // defineProperty: `__proto__` becomes an own key, as a header parser that builds the object that way would make it.
        for (const [k, v] of pairs) Object.defineProperty(h, k, { value: v, enumerable: true, configurable: true, writable: true });
        const a = readAttribution(h, surface) as unknown as Record<string, unknown>;
        expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
        const keys = Object.keys(a).sort();
        expect(keys.filter((k) => k !== 'sanitized')).toEqual([...FIELDS].sort());
        for (const f of FIELDS) expect(bounded(a[f]), `${f}: ${JSON.stringify(a[f])}`).toBe(true);
        if ('sanitized' in a) expect(a.sanitized).toBe(true);
      },
    ),
    fuzz(0xa771, 2_000),
  );
}, fuzzTimeout(10_000));

describe_gateway();

function describe_gateway(): void {
  let gw: TestGateway;
  let closeUp: () => Promise<void>;
  const traces: TraceRecord[] = [];
  beforeAll(async () => {
    process.env[PROVIDER_KEY_ENV] = 'k';
    const up = await startRawUpstream((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } })));
    });
    closeUp = up.close;
    gw = await startGateway({ policy: testPolicy({ upstream: up.url }), traces: { write: (r) => (traces.push(r as TraceRecord), true) }, traceSalt: 's' });
  });
  afterAll(async () => {
    await gw.close();
    await closeUp();
    delete process.env[PROVIDER_KEY_ENV];
  });

  /** One raw HTTP/1.1 request, headers written as bytes (latin1: any byte 0x00 to 0xff); resolves with the status line. */
  function rawRequest(headers: Array<[string, Buffer]>): Promise<string> {
    const u = new URL(gw.url);
    const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }));
    const head = Buffer.concat([
      Buffer.from(`POST /v1/messages HTTP/1.1\r\nhost: x\r\nconnection: close\r\nx-api-key: ${TEST_KEY}\r\ncontent-type: application/json\r\nanthropic-version: 2023-06-01\r\ncontent-length: ${body.length}\r\n`),
      ...headers.flatMap(([k, v]) => [Buffer.from(`${k}: `), v, Buffer.from('\r\n')]),
      Buffer.from('\r\n'),
    ]);
    return new Promise((resolve) => {
      const s = connect(Number(u.port), u.hostname);
      let got = '';
      s.on('data', (c: Buffer) => (got += c.toString('latin1')));
      s.on('error', () => resolve(got.split('\r\n')[0] ?? ''));
      s.on('close', () => resolve(got.split('\r\n')[0] ?? ''));
      // write, not end: a half-closed client counts as gone; `connection: close` makes the gateway close after answering.
      s.write(Buffer.concat([head, body]));
      s.setTimeout(5_000, () => s.destroy());
    });
  }

  test('fuzz: raw requests with hostile header names and arbitrary bytes give bounded trace labels and a normal answer', async () => {
    const valueBytes = fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 200 }).map((u) => Buffer.from(u.filter((b) => b !== 0x0d && b !== 0x0a))),
      headerValue.map((s) => Buffer.from(s.replace(/[\r\n]/g, ''), 'utf8')),
    );
    const seen = { ok: 0, refused: 0 };
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom(...NAMES, ...HOSTILE), valueBytes), { minLength: 1, maxLength: 8 }), async (headers) => {
        const before = traces.length;
        const status = await rawRequest(headers);
        // Node's parser refuses control bytes in a header value (400); everything else is answered by the gateway.
        expect(status).toMatch(/^HTTP\/1\.1 (200|400) /);
        if (!status.includes(' 200 ')) seen.refused++;
        else {
          seen.ok++;
          await expect.poll(() => traces.length).toBe(before + 1);
          const t = traces.at(-1) as TraceRecord;
          const a = t.attribution as unknown as Record<string, unknown>;
          expect(Object.keys(a).filter((k) => k !== 'sanitized').sort()).toEqual([...FIELDS].sort());
          for (const f of FIELDS) expect(bounded(a[f])).toBe(true);
          expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        }
      }),
      fuzz(0xa772, 60),
    );
    expect(seen.ok).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
  }, fuzzTimeout(30_000));
}
