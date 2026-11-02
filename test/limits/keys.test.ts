import { expect, test } from 'vitest';
import { budgetKey, deadlinesKey, gcraKey, keyTaintKey, reservationKey, streamKey, sweepLockKey, taintKey, tenantOfKey, SWEEP_LOCK_TENANT } from '../../src/limits/keys.js';

test('every key starts with the tenant hash tag', () => {
  const keys = [
    budgetKey('acme', 'b', 'v', '2026-11-02'),
    gcraKey('acme', 'l', 'v'),
    streamKey('acme', 'l', 'v'),
    taintKey('acme', 's1'),
    keyTaintKey('acme', 'k1'),
    reservationKey('acme', 'req_1'),
    deadlinesKey('acme'),
    sweepLockKey('acme'),
  ];
  for (const k of keys) expect(k.startsWith('ty:{acme}:')).toBe(true);
  expect(reservationKey('acme', 'req_1')).toBe('ty:{acme}:res:req_1');
  expect(deadlinesKey('acme')).toBe('ty:{acme}:deadlines');
  expect(sweepLockKey('acme')).toBe('ty:{acme}:sweep-lock');
});

test('a tenant name holding { or } cannot break the hash tag', () => {
  for (const tenant of ['a}b', '{x}', 'a{b}c', '}', '{']) {
    const k = budgetKey(tenant, 'b', 'v', null);
    // Redis hashes the text between the first { and the first } after it: that must be the whole encoded tenant.
    const open = k.indexOf('{');
    const close = k.indexOf('}', open + 1);
    expect(k.slice(open + 1, close)).toBe(encodeURIComponent(tenant));
    expect(k.slice(open + 1, close)).not.toMatch(/[{}]/);
    expect(tenantOfKey(k)).toBe(tenant);
  }
});

test('session taint and key taint never share a namespace', () => {
  // A client-chosen session id equal to a key id must not land in that key's taint set.
  expect(taintKey('acme', 'k1')).not.toBe(keyTaintKey('acme', 'k1'));
  expect(taintKey('acme', 's1')).toBe('ty:{acme}:taint:s:s1');
  expect(keyTaintKey('acme', 'k1')).toBe('ty:{acme}:taint:k:k1');
  // The prefix is outside the encoded part, so a session spelled like the key form cannot collide either.
  expect(taintKey('acme', 'k:k1')).not.toBe(keyTaintKey('acme', 'k1'));
});

test('tenantOfKey returns null for a key outside the ty:{tenant}: layout', () => {
  expect(tenantOfKey('other:{acme}:x')).toBeNull();
  expect(tenantOfKey('ty:acme:x')).toBeNull();
});

test('the sweep lock lives under the reserved tenant "_sweeper", keeping the {tenant} rule', () => {
  expect(sweepLockKey(SWEEP_LOCK_TENANT)).toBe('ty:{_sweeper}:sweep-lock');
});
