import { Transform } from 'node:stream';

export type Tee = Transform & { readonly onChunkErrors: number };

/**
 * Pass-through transform. Each chunk goes downstream first, then onChunk sees it.
 * Exceptions in onChunk are caught and counted; they never affect the stream.
 */
export function createTee(onChunk: (chunk: Buffer) => void): Tee {
  let errors = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      this.push(chunk);
      try {
        onChunk(chunk);
      } catch {
        errors++;
      }
      cb();
    },
  });
  Object.defineProperty(t, 'onChunkErrors', { get: () => errors });
  return t as Tee;
}
