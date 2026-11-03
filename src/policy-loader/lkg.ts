// Last-known-good bundle in --state-dir (spec 6.7). One file, replaced atomically, with its own sha256.
import { createHash } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { cliRoot, ensureDirUnder, PRIVATE_DIR_MODE, readFileUnder, writeFileUnder } from '../fsutil/safe-path.js';
import { join } from 'node:path';
import { MAX_BUNDLE_BYTES, parseBundle, type Bundle } from '../policy/bundle.js';

export const LKG_FILE = 'last-known-good.json';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Writes `bundleText` as `{ sha256, bundle }` to a temp file in the same directory, then renames it over the old one. */
export async function writeLkg(stateDir: string, bundleText: string): Promise<void> {
  // No symbolic link from the state dir's root down (S-FS-1); the temp file is created exclusively, never through a link.
  const root = cliRoot(stateDir);
  await ensureDirUnder(root, stateDir, PRIVATE_DIR_MODE);
  const tmp = join(stateDir, `${LKG_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFileUnder(root, tmp, JSON.stringify({ sha256: sha(bundleText), bundle: bundleText }), { exclusive: true, private: true });
    await rename(tmp, join(stateDir, LKG_FILE));
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** The stored bundle, or null when there is none. A file whose sha256 does not match, or whose bundle does not verify, throws: a tampered copy is refused. */
export async function readLkg(stateDir: string): Promise<Bundle | null> {
  // Read through the S-FS-1 helper: no symbolic link on the way, a regular file, bounded (the bundle as a JSON string).
  const raw = await readFileUnder(cliRoot(stateDir), join(stateDir, LKG_FILE), MAX_BUNDLE_BYTES * 8).catch((e: unknown) => {
    if (e instanceof Error && /larger than/.test(e.message)) throw new Error('last-known-good file is too large');
    throw e;
  });
  if (raw === undefined) return null;
  const text = raw.toString('utf8');
  if (text.length > MAX_BUNDLE_BYTES * 2) throw new Error('last-known-good file is too large');
  let env: unknown;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('last-known-good file is not valid JSON');
  }
  const e = env as { sha256?: unknown; bundle?: unknown };
  if (typeof e !== 'object' || e === null || typeof e.sha256 !== 'string' || typeof e.bundle !== 'string') throw new Error('last-known-good file has the wrong shape');
  if (sha(e.bundle) !== e.sha256) throw new Error('last-known-good sha256 mismatch: the file was modified');
  return parseBundle(e.bundle);
}
