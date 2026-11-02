import { expect, test } from 'vitest';
import { buildBundle, parseBundle, serializeBundle } from '../../src/policy/bundle.js';
import { parsePolicyFiles } from '../../src/policy/load-dir.js';
import { EXAMPLE_PRICES } from './helpers.js';
import { keysYaml, policyYaml } from '../helpers/policy-dir.js';

const AT = '2026-11-02T10:00:00.000Z';
const src = (policy: string, keys: string) => parsePolicyFiles('t', { 'policy.yaml': policy, 'prices.yaml': EXAMPLE_PRICES, 'keys.yaml': keys });
const base = (): ReturnType<typeof buildBundle> => buildBundle(src(policyYaml('http://127.0.0.1:1', 'x'), keysYaml()), { createdAt: AT });

test('bundle sha256 is stable across key order and CRLF', () => {
  const a = base();
  const crlf = policyYaml('http://127.0.0.1:1', 'x').replace(/\n/g, '\r\n');
  const keyRecord = JSON.parse(keysYaml().slice(2)) as Record<string, string>;
  const reordered = `- ${JSON.stringify(Object.fromEntries(Object.entries(keyRecord).reverse()))}\n`;
  const b = buildBundle(src(`﻿${crlf}`, reordered), { createdAt: '2030-01-01T00:00:00.000Z' });
  expect(b.manifest.sha256).toBe(a.manifest.sha256);
  expect(b.manifest.revision).toBe(a.manifest.sha256.slice(0, 12));
  const other = buildBundle(src(policyYaml('http://127.0.0.1:1', 'y'), keysYaml()), { createdAt: AT });
  expect(other.manifest.sha256).not.toBe(a.manifest.sha256);
});

test('keys are sorted by hash and the revision can be given', () => {
  const k2 = `${keysYaml()}- {"hash":"${'0'.repeat(64)}","keyId":"key_zero","tenant":"acme","team":null,"name":"z","kind":"service","billing":"api"}\n`;
  const b = buildBundle(src(policyYaml('http://127.0.0.1:1', 'x'), k2), { createdAt: AT, revision: 'abc123' });
  expect(b.keys.map((k) => k.keyId)).toEqual(['key_zero', 'key_test']);
  expect(b.manifest).toMatchObject({ revision: 'abc123', schemaVersion: 1, createdAt: AT });
});

test('a written bundle parses back to the same content', () => {
  const b = base();
  expect(parseBundle(serializeBundle(b))).toEqual(b);
});

test('bundle with wrong sha256 is rejected', () => {
  const b = base();
  const tampered = JSON.parse(serializeBundle(b)) as { policy: { metadata: { name: string } } };
  tampered.policy.metadata.name = 'evil';
  expect(() => parseBundle(JSON.stringify(tampered))).toThrow(/sha256 mismatch/);
  const wrong = JSON.parse(serializeBundle(b)) as { manifest: { sha256: string } };
  wrong.manifest.sha256 = '0'.repeat(64);
  expect(() => parseBundle(JSON.stringify(wrong))).toThrow(/sha256 mismatch/);
});

test('a __proto__ key is refused at any depth, even with a matching sha256', () => {
  const text = serializeBundle(base()).replace('"metadata": {', '"metadata": {\n      "__proto__": {"polluted": true},');
  expect(() => parseBundle(text)).toThrow(/__proto__/);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test('manifest and shape errors', () => {
  const b = JSON.parse(serializeBundle(base())) as { manifest: Record<string, unknown> };
  expect(() => parseBundle('not json')).toThrow(/not valid JSON/);
  expect(() => parseBundle('[]')).toThrow(/JSON object/);
  expect(() => parseBundle(JSON.stringify({ ...b, manifest: { ...b.manifest, schemaVersion: 2 } }))).toThrow(/schemaVersion/);
  expect(() => parseBundle(JSON.stringify({ ...b, manifest: { ...b.manifest, revision: '../x' } }))).toThrow(/revision/);
  expect(() => parseBundle(' '.repeat(9 * 1024 * 1024))).toThrow(/larger/);
});
