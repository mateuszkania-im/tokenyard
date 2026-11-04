import { type Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

/**
 * `src` piped into `dst` (backpressure and errors as `pipeline` gives them), with `onChunk` seeing each chunk right
 * after it was written downstream: the tee's contract without a Transform stage between the two, whose own buffering
 * cost a stream step and two deferred callbacks per chunk (0.2.1). Exceptions in onChunk are caught; they never affect
 * the stream.
 */
export function pipeWithTap(src: Readable, dst: Writable, onChunk: (chunk: Buffer) => void): Promise<void> {
  // pipeline attaches its own 'data' listener synchronously, so this one runs after the chunk was written.
  const done = pipeline(src, dst);
  src.on('data', (chunk: Buffer) => {
    try {
      onChunk(chunk);
    } catch {
      // the tap never affects the stream
    }
  });
  return done;
}
