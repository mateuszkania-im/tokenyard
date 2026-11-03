// Hostile bodies for the S-V3-3 scan work budget: 32 MiB minus 4 KiB (under the gateway's body cap), no escapes, the
// cost in many small JSON values or many rule matches. Shared by the budget test and its memory child process.

export const MODEL = 'claude-haiku-5-5';
const SIZE = 32 * 1024 * 1024 - 4096;

export type Shape = 'short-strings' | 'bare-tokens' | 'dense-matches';
export type Place = 'last-turn' | 'history';

/** An AWS-key-shaped value, built at runtime so no committed file holds one (check:secrets, push protection). */
export const KEY_SHAPED = `${'AK'}IA${'A'.repeat(16)}`;

const UNITS: Record<Shape, { open: string; unit: string; close: string }> = {
  // Each JSON string is a separator run and a text run in the scanner, a string node in JSON.parse.
  'short-strings': { open: '[', unit: '"a",', close: '"a"]' },
  // Each token outside quotes: two runs, a number node.
  'bare-tokens': { open: '[', unit: '1,', close: '1]' },
  // One string of AWS-key-shaped values: one regex match (segments, span, HMAC) per 21 bytes.
  'dense-matches': { open: '"', unit: `${KEY_SHAPED} `, close: 'x"' },
};

/** A coding-agent shaped body of about 32 MiB whose `shape` content is the newest user turn or an earlier one. */
export function hostileBody(shape: Shape, place: Place): Buffer {
  const { open, unit, close } = UNITS[shape];
  const head = `{"model":"${MODEL}","max_tokens":64,"messages":[`;
  const tail = place === 'history' ? ',{"role":"assistant","content":"ok"},{"role":"user","content":"next"}]}' : ']}';
  const room = SIZE - head.length - tail.length - 40 - open.length - close.length;
  const content = open + unit.repeat(Math.floor(room / unit.length)) + close;
  return Buffer.from(`${head}{"role":"user","content":${content}}${tail}`);
}

export const SHAPES: readonly Shape[] = ['short-strings', 'bare-tokens', 'dense-matches'];
export const PLACES: readonly Place[] = ['last-turn', 'history'];
