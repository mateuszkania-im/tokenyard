import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { LedgerLine } from './record.js';

/** Optional caps on what one file may hold after decompression: total bytes and bytes in one line. */
export interface LedgerLimits {
  maxBytes?: number;
  maxLineBytes?: number;
}

/** Passes bytes through and fails the stream once the total or one line (bytes between line breaks) goes over its cap. */
function capped(path: string, maxBytes: number, maxLineBytes: number): Transform {
  let total = 0;
  let line = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(new Error(`${path} holds more than ${maxBytes} bytes after decompression`));
      let start = 0;
      for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
        if (line + nl - start > maxLineBytes) break;
        line = 0;
        start = nl + 1;
      }
      line += chunk.length - start;
      if (line > maxLineBytes) return cb(new Error(`${path} has a line longer than ${maxLineBytes} bytes`));
      cb(null, chunk);
    },
  });
}

/**
 * Lines of ledger files in the order given, plain or `.gz`. A line that is not valid JSON (the torn last
 * line of a file the process died while writing) is skipped. With `limits`, a file over either cap throws.
 */
export async function* readLedger(paths: string[], limits: LedgerLimits = {}): AsyncIterable<LedgerLine> {
  for (const path of paths) {
    // Never through a symbolic link at the file itself, never a FIFO or device (O_NONBLOCK, then a regular file only);
    // callers check the directories (S-FS-1).
    const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await fh.stat()).isFile()) {
      await fh.close();
      throw new Error(`${path} is not a regular file`);
    }
    const file = fh.createReadStream();
    const plain = path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
    file.on('error', (e) => plain.destroy(e));
    const input = limits.maxBytes === undefined && limits.maxLineBytes === undefined ? plain : plain.pipe(capped(path, limits.maxBytes ?? Number.POSITIVE_INFINITY, limits.maxLineBytes ?? Number.POSITIVE_INFINITY));
    if (input !== plain) plain.on('error', (e: Error) => input.destroy(e));
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
