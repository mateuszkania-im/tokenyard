// PII rules for product traffic (spec 6.6): email, PESEL, IBAN and card numbers, each number with its checksum so a
// near-miss does not match. Pure.
import type { SecretRule } from './rules.js';

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

/** Polish PESEL: 11 digits, a valid month (the century is encoded in it), a day from 1 to 31 and the check digit. */
export function peselValid(s: string): boolean {
  if (!/^\d{11}$/.test(s)) return false;
  const d = [...s].map(Number);
  const month = ((d[2] ?? 0) * 10 + (d[3] ?? 0)) % 20;
  const day = (d[4] ?? 0) * 10 + (d[5] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const sum = PESEL_WEIGHTS.reduce((acc, w, i) => acc + w * (d[i] ?? 0), 0);
  return (10 - (sum % 10)) % 10 === d[10];
}

/** IBAN: country code, two check digits, up to 30 alphanumerics (spaces allowed), mod-97 equal to 1 (ISO 13616). */
export function ibanValid(s: string): boolean {
  const iban = s.replace(/ /g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/** Card number: 13 to 19 digits (spaces or dashes between them allowed) passing the Luhn check. */
export function luhnValid(s: string): boolean {
  const digits = s.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const TOKENYARD = 'MIT (tokenyard)';

export const PII_RULES: readonly SecretRule[] = Object.freeze([
  {
    id: 'email',
    keywords: ['@'],
    regex: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24})(?![A-Za-z0-9-])/,
    source: 'tokenyard',
    licence: TOKENYARD,
  },
  {
    id: 'pesel',
    keywords: [],
    regex: /(?<![0-9])(\d{11})(?![0-9])/,
    source: 'tokenyard (checksum per the PESEL specification)',
    licence: TOKENYARD,
    validate: peselValid,
  },
  {
    id: 'iban',
    keywords: [],
    regex: /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/,
    source: 'tokenyard (ISO 13616 mod-97)',
    licence: TOKENYARD,
    validate: ibanValid,
  },
  {
    id: 'card-number',
    keywords: [],
    regex: /(?<![0-9])(\d(?:[ -]?\d){12,18})(?![0-9])/,
    source: 'tokenyard (Luhn)',
    licence: TOKENYARD,
    validate: luhnValid,
  },
]);
