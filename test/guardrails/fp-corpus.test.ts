// Spec 6.6 "measured, not assumed": source trees and lockfiles sent as tool results must give zero block hits.
// Sources are listed in test/fixtures/fp-corpus/README.md.
import { expect, test } from 'vitest';
import { corpus, scanCorpus } from '../helpers/fp-corpus.js';

test('false-positive corpus (why-diff, read-receipts, tokenyard trees, lockfiles, fixtures) gives zero block hits', () => {
  const files = corpus();
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((f) => f.file.endsWith('package-lock.json'))).toBe(true);
  const r = scanCorpus(files);
  console.log(`fp corpus: ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB; documented example values matched: ${r.examples}; block hits: ${r.offenders.length}`);
  expect(r.offenders).toEqual([]);
});
