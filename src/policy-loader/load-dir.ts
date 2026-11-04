// Reads a policy directory and hands the text to the pure parser (R-P2).
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPath, cliRoot } from '../fsutil/safe-path.js';
import { MAX_YAML_BYTES } from '../policy/safe-yaml.js';
import { parsePolicyFiles, parsePolicyText, policyFileNames, POLICY_FILE, PolicyLoadError, type PolicySource } from '../policy/load-dir.js';

/**
 * One policy file as text, or undefined when it does not exist. Only a regular file that is not a symbolic link is read
 * (a link could point at any file on the runner, and its keys would show up in error messages), and only up to the size
 * cap: the size is checked before reading and the read itself is bounded (a FIFO or /dev/zero never gets that far).
 */
async function readOrMissing(dir: string, name: string): Promise<string | undefined> {
  const path = join(dir, name);
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw e;
  }
  if (!st.isFile()) throw new PolicyLoadError('E_YAML_UNSAFE', name, [{ path: '', message: 'must be a regular file (symbolic links and special files are refused)' }]);
  if (st.size > MAX_YAML_BYTES) throw new PolicyLoadError('E_YAML_UNSAFE', name, [{ path: '', message: `file is larger than ${MAX_YAML_BYTES} bytes` }]);
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buf = Buffer.alloc(MAX_YAML_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_YAML_BYTES) throw new PolicyLoadError('E_YAML_UNSAFE', name, [{ path: '', message: `file is larger than ${MAX_YAML_BYTES} bytes` }]);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Loads policy.yaml and the files it names from `dir`. Throws PolicyLoadError (E_FILE_MISSING, E_YAML_UNSAFE, E_SCHEMA,
 * ...). The directory must lie below `root` (default: the working directory, or its own parent when outside it) with no
 * symbolic link on the way (S-FS-1): UnsafePathError otherwise.
 */
export async function loadPolicyDir(dir: string, o: { root?: string } = {}): Promise<PolicySource> {
  try {
    await checkPath(o.root ?? cliRoot(dir), dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const files: Record<string, string> = {};
  const policy = await readOrMissing(dir, POLICY_FILE);
  if (policy === undefined) throw new PolicyLoadError('E_FILE_MISSING', POLICY_FILE, [{ path: '', message: `${POLICY_FILE} not found in ${dir}` }]);
  files[POLICY_FILE] = policy;
  // policy.yaml is parsed once: for the names of the other files and for the policy itself.
  const parsed = parsePolicyText(policy);
  for (const name of policyFileNames(parsed)) {
    if (name === POLICY_FILE) continue;
    const text = await readOrMissing(dir, name);
    if (text !== undefined) files[name] = text;
  }
  return parsePolicyFiles(dir, files, parsed);
}

export { PolicyLoadError, type PolicySource };
