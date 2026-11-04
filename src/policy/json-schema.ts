// JSON Schema export for editor completion: `tokenyard policy schema > policy.schema.json`. Pure.
import { z } from 'zod';
import { policySchema } from './schema.js';

/** JSON Schema (draft 2020-12) of policy.yaml, in input form: fields with defaults are optional. */
export function policyJsonSchema(): object {
  return z.toJSONSchema(policySchema, { io: 'input', unrepresentable: 'any' });
}
