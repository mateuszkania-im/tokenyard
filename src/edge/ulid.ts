import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** ULID (spec 6.5): 48-bit millisecond time then 80 random bits, 26 characters. Not monotonic within one millisecond. */
export function ulid(nowMs: number = Date.now()): string {
  let t = Math.floor(nowMs);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = BigInt(`0x${randomBytes(10).toString('hex')}`);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(r & 31n)] + rand;
    r >>= 5n;
  }
  return time + rand;
}
