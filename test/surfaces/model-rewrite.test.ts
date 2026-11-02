import { expect, test } from 'vitest';
import { rewriteTopLevelModel } from '../../src/surfaces/anthropic-messages.js';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

test('replaces only the bytes of the top-level model string; every other byte is identical', () => {
  const src = '{ "max_tokens" : 64,\n  "metadata": {"model": "inner"},\r\n  "model"\t:  "claude-opus-5-5" ,\n "messages":[{"role":"user","content":"\\"model\\": \\"x\\" żółw"}], "z": [1, {"model": 2}] }';
  const out = rewriteTopLevelModel(b(src), 'claude-haiku-5-5');
  expect(out?.toString('utf8')).toBe(src.replace('"claude-opus-5-5"', '"claude-haiku-5-5"'));
  expect(JSON.parse(out?.toString('utf8') ?? '').metadata.model).toBe('inner');
});

test('an escaped key or value is located exactly', () => {
  const src = '{"mod\\u0065l":"claude\\u002dopus-5-5","messages":[]}';
  expect(rewriteTopLevelModel(b(src), 'claude-haiku-5-5')?.toString()).toBe('{"mod\\u0065l":"claude-haiku-5-5","messages":[]}');
});

test('the new value is JSON-escaped', () => {
  expect(rewriteTopLevelModel(b('{"model":"a"}'), 'x"y')?.toString()).toBe('{"model":"x\\"y"}');
});

test('returns null when the model cannot be located exactly', () => {
  for (const src of [
    '{"model":"a","model":"b"}', // duplicate key: JSON.parse keeps the last, the bytes are ambiguous
    '{"messages":[]}', // no model
    '{"model":7}', // not a string
    '{"model":"a"', // not JSON
    '﻿{"model":"a"}', // BOM: not what JSON.parse accepts
    '["model","a"]',
    '{"metadata":{"model":"a"}}', // nested only
  ]) {
    expect(rewriteTopLevelModel(b(src), 'claude-haiku-5-5'), src).toBeNull();
  }
});
