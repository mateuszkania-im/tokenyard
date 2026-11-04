import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePriceTable } from '../../src/pricing/prices.js';

/** The example price table shipped in examples/policy (values from the live pricing pages). */
export const PRICES_PATH = join(import.meta.dirname, '..', '..', 'examples', 'policy', 'prices.yaml');
export const loadPrices = () => parsePriceTable(readFileSync(PRICES_PATH, 'utf8'));
