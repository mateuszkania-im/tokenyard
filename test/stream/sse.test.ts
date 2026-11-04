import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { SseParser, type SseEvent } from '../../src/stream/sse.js';

const fixture = readFileSync(new URL('../fixtures/sse/anthropic-basic.txt', import.meta.url));

function parseAll(chunks: Buffer[]): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

test('parser handles events split at every byte offset', () => {
  const whole = parseAll([fixture]);
  expect(whole.length).toBe(9);
  const bytes: Buffer[] = [];
  for (let i = 0; i < fixture.length; i++) bytes.push(fixture.subarray(i, i + 1));
  expect(parseAll(bytes)).toEqual(whole);
  for (let cut = 1; cut < fixture.length; cut += 7) {
    expect(parseAll([fixture.subarray(0, cut), fixture.subarray(cut)])).toEqual(whole);
  }
});

test('multi-byte characters split across chunks are not corrupted', () => {
  const whole = parseAll([fixture]);
  expect(whole.some((e) => e.data.includes('日本語'))).toBe(true);
});

test('parser handles CRLF, LF and CR line ends and multi-line data', () => {
  const expected = [{ event: 'x', data: 'a\nb' }];
  for (const nl of ['\n', '\r\n', '\r']) {
    const text = `event: x${nl}data: a${nl}data: b${nl}${nl}`;
    expect(parseAll([Buffer.from(text)])).toEqual(expected);
    const bytes = [...Buffer.from(text)].map((b) => Buffer.from([b]));
    expect(parseAll(bytes)).toEqual(expected);
  }
});

test('comments are ignored, missing event is null, one leading space is stripped', () => {
  expect(parseAll([Buffer.from(': hi\ndata:  two\n\n')])).toEqual([{ event: null, data: ' two' }]);
});

test('an unterminated trailing event is dropped', () => {
  expect(parseAll([Buffer.from('event: a\ndata: 1\n\nevent: b\ndata: 2')])).toEqual([{ event: 'a', data: '1' }]);
});
