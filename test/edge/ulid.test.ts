import { expect, test } from 'vitest';
import { ulid } from '../../src/edge/ulid.js';

test('ulid is 26 Crockford base32 chars, encodes the timestamp and sorts by time', () => {
  const a = ulid(0);
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(a.slice(0, 10)).toBe('0000000000');
  expect(ulid(1_000) < ulid(2_000)).toBe(true);
  expect(new Set(Array.from({ length: 1000 }, () => ulid(5))).size).toBe(1000);
});

test('ulid timestamp part decodes back to the millisecond', () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ms = 1_793_577_600_123;
  const decoded = ulid(ms).slice(0, 10).split('').reduce((n, c) => n * 32 + alphabet.indexOf(c), 0);
  expect(decoded).toBe(ms);
});
