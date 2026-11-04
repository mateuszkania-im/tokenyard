import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, test } from 'vitest';
import { createTee, pipeWithTap } from '../../src/stream/tee.js';

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

// pipeWithTap (0.2.1): the handler's forwarding without a Transform stage. Same contract as the tee.

test('pipeWithTap forwards identical bytes and ignores a throwing onChunk', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')];
  const seen: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      seen.push(c);
      cb();
    },
  });
  let calls = 0;
  await pipeWithTap(Readable.from(chunks), sink, () => {
    calls++;
    throw new Error('boom');
  });
  expect(Buffer.concat(seen).toString()).toBe('abcdefghi');
  expect(calls).toBe(3);
});

test('pipeWithTap writes each chunk downstream before onChunk sees it, and onChunk sees every chunk once, in order', async () => {
  const order: string[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      order.push(`write ${c.toString()}`);
      cb();
    },
  });
  await pipeWithTap(Readable.from([Buffer.from('a'), Buffer.from('b')]), sink, (c) => order.push(`tap ${c.toString()}`));
  expect(order).toEqual(['write a', 'tap a', 'write b', 'tap b']);
});

test('pipeWithTap keeps backpressure: a slow sink with a small buffer still gets every byte, in order', async () => {
  const chunks = Array.from({ length: 200 }, (_, i) => Buffer.alloc(1024, i % 251));
  const seen: Buffer[] = [];
  let tapped = 0;
  const sink = new Writable({
    highWaterMark: 1024,
    write(c: Buffer, _e, cb) {
      seen.push(c);
      setImmediate(cb);
    },
  });
  await pipeWithTap(Readable.from(chunks), sink, (c) => (tapped += c.length));
  expect(Buffer.concat(seen).equals(Buffer.concat(chunks))).toBe(true);
  expect(tapped).toBe(200 * 1024);
});

test('pipeWithTap rejects when the source fails, after forwarding what arrived', async () => {
  const seen: Buffer[] = [];
  const src = new Readable({ read() {} });
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      seen.push(c);
      cb();
    },
  });
  const done = pipeWithTap(src, sink, () => undefined);
  src.push(Buffer.from('part'));
  setImmediate(() => src.destroy(new Error('upstream reset')));
  await expect(done).rejects.toThrow('upstream reset');
  expect(Buffer.concat(seen).toString()).toBe('part');
});
