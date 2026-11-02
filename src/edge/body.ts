import type { IncomingMessage } from 'node:http';

export class BodyTooLargeError extends Error {
  constructor(readonly capBytes: number) {
    super(`request body exceeds ${capBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export class BodyAbortedError extends Error {
  constructor() {
    super('client closed the connection while sending the body');
    this.name = 'BodyAbortedError';
  }
}

/**
 * Read the whole request body into one Buffer, up to `capBytes`.
 * Over the cap it rejects with BodyTooLargeError at once and discards the rest of the upload.
 */
export function readBody(req: IncomingMessage, capBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > capBytes) {
      req.resume();
      reject(new BodyTooLargeError(capBytes));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      if (err) {
        req.resume();
        reject(err);
      } else resolve(Buffer.concat(chunks, size));
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > capBytes) finish(new BodyTooLargeError(capBytes));
      else chunks.push(c);
    };
    req.on('data', onData);
    req.once('end', () => finish(null));
    req.once('error', (e) => finish(e));
    req.once('close', () => finish(req.complete ? null : new BodyAbortedError()));
  });
}
