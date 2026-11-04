// Last-known-good bundle in --state-dir (spec 6.7). One file, replaced atomically, with its own sha256. The sha256
// detects corruption (a torn or edited copy); it is not authentication: whoever can write the state directory as the
// gateway's user can write a valid file (C10). The directory is the gateway's own, private, like its trace directory.
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

/**
 * The stored bundle, or null when there is none. Throws when the file is not owned by this user with mode 0600, when
 * its sha256 does not match (corruption), or when its bundle does not verify.
 */
export async function readLkg(stateDir: string): Promise<Bundle | null> {
  // Read through the S-FS-1 helper: no symbolic link on the way, a regular file, bounded (the bundle as a JSON string).
  const raw = await readFileUnder(cliRoot(stateDir), join(stateDir, LKG_FILE), MAX_BUNDLE_BYTES * 8, { ownPrivate: true }).catch((e: unknown) => {
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
