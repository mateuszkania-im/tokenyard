// Price table (spec 6.3): USD per million tokens, so tokens times price is micro-USD. Pure: parses text, no I/O.
import { parseYamlSafe } from '../policy/safe-yaml.js';
import { z } from 'zod';

const rate = z.number().nonnegative();
const tokens = z.number().int().positive();
const provenance = { source: z.string().min(1), retrieved: z.string().min(1) };

const tierSchema = z.strictObject({
  aboveInputTokens: z.number().int().nonnegative(),
  input: rate,
  output: rate,
  cacheWrite5m: rate,
  cacheWrite1h: rate,
  cacheRead: rate,
});

/** Fast mode (`speed: "fast"`) prices: they replace the base prices and tiers across the whole context window. */
const fastSchema = z.strictObject({
  input: rate,
  output: rate,
  cacheWrite5m: rate,
  cacheWrite1h: rate,
  cacheRead: rate,
  ...provenance,
});

const modelSchema = z.strictObject({
  input: rate,
  output: rate,
  cacheWrite5m: rate,
  cacheWrite1h: rate,
  cacheRead: rate,
  maxContextTokens: tokens,
  maxOutputTokens: tokens,
  tiers: z.array(tierSchema).optional(),
  fast: fastSchema.optional(),
  ...provenance,
});

const tableSchema = z.strictObject({
  version: z.coerce.string().min(1),
  models: z.record(z.string(), modelSchema),
  modifiers: z.record(z.string(), z.number().positive()).default({}),
  serverTools: z
    .record(z.string(), z.strictObject({ perUseUsd: rate, maxIterations: z.number().int().positive(), ...provenance }))
    .default({}),
});

export type ModelPrice = z.infer<typeof modelSchema>;
export type PriceTable = z.infer<typeof tableSchema>;

/** Parses and validates a price table. A model without `maxContextTokens` or `maxOutputTokens` is an error (the worst-case bound needs them). */
export function parsePriceTable(text: string): PriceTable {
  const raw: unknown = parseYamlSafe(text);
  // Tables are keyed by user text; a `__proto__` key would set a prototype instead of an entry, so refuse it outright.
  if (typeof raw === 'object' && raw !== null) {
    for (const section of ['models', 'modifiers', 'serverTools']) {
      const map = (raw as Record<string, unknown>)[section];
      if (typeof map === 'object' && map !== null && Object.hasOwn(map, '__proto__')) {
        throw new Error(`invalid price table: ${section}: key __proto__ is not allowed`);
      }
    }
  }
  const r = tableSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid price table: ${issues.join('; ')}`);
  }
  return r.data;
}

/** Exact id, else the longest table id followed by `-` that prefixes the model, so dated ids resolve. */
export function lookupModel(t: PriceTable, model: string): { id: string; price: ModelPrice } | null {
  // Own properties only: `constructor` and friends must never resolve to a non-price object.
  if (Object.hasOwn(t.models, model)) {
    const exact = t.models[model];
    if (exact) return { id: model, price: exact };
  }
  let best: string | null = null;
  for (const id of Object.keys(t.models)) {
    if (model.startsWith(`${id}-`) && (best === null || id.length > best.length)) best = id;
  }
  const price = best === null ? undefined : t.models[best];
  return best !== null && price ? { id: best, price } : null;
}
