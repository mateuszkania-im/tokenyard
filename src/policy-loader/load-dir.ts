// Reads a policy directory and hands the text to the pure parser (R-P2).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePolicyFiles, policyFileNames, POLICY_FILE, PolicyLoadError, type PolicySource } from '../policy/load-dir.js';

async function readOrMissing(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, name), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw e;
  }
}

/** Loads policy.yaml and the files it names from `dir`. Throws PolicyLoadError (E_FILE_MISSING, E_YAML_UNSAFE, E_SCHEMA, ...). */
export async function loadPolicyDir(dir: string): Promise<PolicySource> {
  const files: Record<string, string> = {};
  const policy = await readOrMissing(dir, POLICY_FILE);
  if (policy === undefined) throw new PolicyLoadError('E_FILE_MISSING', POLICY_FILE, [{ path: '', message: `${POLICY_FILE} not found in ${dir}` }]);
  files[POLICY_FILE] = policy;
  for (const name of policyFileNames(policy)) {
    if (name === POLICY_FILE) continue;
    const text = await readOrMissing(dir, name);
    if (text !== undefined) files[name] = text;
  }
  return parsePolicyFiles(dir, files);
}

export { PolicyLoadError, type PolicySource };
