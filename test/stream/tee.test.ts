import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, test } from 'vitest';
import { createTee } from '../../src/stream/tee.js';

test('tee emits identical bytes even when onChunk throws', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')];
  const seen: Buffer[] = [];
  const tee = createTee(() => {
    throw new Error('boom');
  });
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      seen.push(c);
      cb();
    },
  });
  await pipeline(Readable.from(chunks), tee, sink);
  expect(Buffer.concat(seen).toString()).toBe('abcdefghi');
  expect(tee.onChunkErrors).toBe(3);
});

test('tee pushes the chunk downstream before calling onChunk', () => {
  const order: string[] = [];
  const tee = createTee(() => order.push('onChunk'));
  const orig = tee.push.bind(tee);
  tee.push = (c: unknown) => {
    order.push('push');
    return orig(c as Buffer);
  };
  tee.write(Buffer.from('x'));
  expect(order).toEqual(['push', 'onChunk']);
});
