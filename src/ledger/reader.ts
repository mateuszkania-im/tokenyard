import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { LedgerLine } from './record.js';

/**
 * Lines of ledger files in the order given, plain or `.gz`. A line that is not valid JSON (the torn last
 * line of a file the process died while writing) is skipped.
 */
export async function* readLedger(paths: string[]): AsyncIterable<LedgerLine> {
  for (const path of paths) {
    // Never through a symbolic link at the file itself; callers check the directories (S-FS-1).
    const file = (await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))).createReadStream();
    const input = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
    file.on('error', (e) => input.destroy(e));
    for await (const text of createInterface({ input, crlfDelay: Infinity })) {
      if (text === '') continue;
      try {
        const line = JSON.parse(text) as LedgerLine;
        if (typeof line === 'object' && line !== null && typeof line.kind === 'string') yield line;
      } catch {
        // torn line
      }
    }
  }
}
