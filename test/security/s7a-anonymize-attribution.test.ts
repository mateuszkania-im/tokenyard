// S7a (coordinator finding, Task 7, MEDIUM): anonymizeRecord left free-text attribution (feature, agentType,
// requestClass, other header-derived values) in clear in --anonymize exports. Deny by default: only fixed enum values
// survive; everything else goes through the pseudonym function, and an attribution key nobody named never survives.
import { expect, test } from 'vitest';
import { anonymizeRecord } from '../../src/ledger/anonymize.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { baseRecord } from '../helpers/trace.js';

const CANARY = 'CANARY-customer-acme-secret';

test('S7a free-text attribution never reaches an anonymized record', () => {
  const r = baseRecord();
  const attribution = {
    ...r.attribution,
    requestClass: `${CANARY}-class`,
    agentType: `${CANARY}-agent`,
    feature: `${CANARY}-feature`,
    repo: `${CANARY}-repo`,
    branch: `${CANARY}-branch`,
    ticket: `${CANARY}-ticket`,
    extraHeaderDerived: `${CANARY}-extra`,
  } as TraceRecord['attribution'];
  const out = anonymizeRecord({ ...r, attribution, instance: 'i', seq: 1 }, (k, v) => `${k}:${v.length}`);
  expect(JSON.stringify(out)).not.toContain('CANARY');
  expect(Object.keys(out.attribution).sort()).toEqual(Object.keys(r.attribution).sort());
});

test('S7a only the fixed request-class and agent-type values stay readable', () => {
  const r = baseRecord();
  const p = (): string => 'pseudo';
  const known = anonymizeRecord({ ...r, attribution: { ...r.attribution, requestClass: 'compaction', agentType: 'Explore' }, instance: 'i', seq: 1 }, p);
  expect(known.attribution).toMatchObject({ requestClass: 'compaction', agentType: 'Explore' });
  const custom = anonymizeRecord({ ...r, attribution: { ...r.attribution, requestClass: 'Compaction ', agentType: 'explore' }, instance: 'i', seq: 1 }, p);
  expect(custom.attribution).toMatchObject({ requestClass: 'pseudo', agentType: 'pseudo' });
});
