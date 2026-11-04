// Fetches a bundle over HTTPS (spec 6.7, 11): no redirects, capped size and time, ETag revalidation.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { MAX_BUNDLE_BYTES } from '../policy/bundle.js';

export const FETCH_TIMEOUT_MS = 10_000;

export type FetchResult = { status: 'not-modified' } | { status: 'ok'; text: string; etag: string | null };

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** https only; http is allowed for loopback so a test or a sidecar can serve a bundle. Throws on anything else. */
export function checkPolicyUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`policy URL is not a valid URL: ${raw}`);
  }
  if (u.username || u.password) throw new Error('policy URL must not carry credentials');
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return u;
  throw new Error('policy URL must be https (http is allowed only for 127.0.0.1 and localhost)');
}

export function fetchBundle(rawUrl: string, o: { etag: string | null; timeoutMs?: number; maxBytes?: number }): Promise<FetchResult> {
  const url = checkPolicyUrl(rawUrl);
  const maxBytes = o.maxBytes ?? MAX_BUNDLE_BYTES;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = send(url, { method: 'GET', headers: { accept: 'application/json', ...(o.etag ? { 'if-none-match': o.etag } : {}) } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status === 304) {
        res.resume();
        return done(() => resolve({ status: 'not-modified' }));
      }
      if (status >= 300 && status < 400) {
        res.resume();
        return done(() => reject(new Error(`policy URL answered ${status}: redirects are not followed`)));
      }
      if (status !== 200) {
        res.resume();
        return done(() => reject(new Error(`policy URL answered ${status}`)));
      }
      const enc = res.headers['content-encoding'];
      if (enc && enc !== 'identity') {
        res.resume();
        return done(() => reject(new Error(`policy URL answered with content-encoding ${enc}`)));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        return done(() => reject(new Error(`policy response is larger than ${maxBytes} bytes`)));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          done(() => reject(new Error(`policy response is larger than ${maxBytes} bytes`)));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const etag = res.headers.etag;
        done(() => resolve({ status: 'ok', text: Buffer.concat(chunks).toString('utf8'), etag: typeof etag === 'string' ? etag : null }));
      });
      res.on('error', (e) => done(() => reject(e)));
      res.on('aborted', () => done(() => reject(new Error('policy response was cut off'))));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new Error(`policy URL did not answer within ${o.timeoutMs ?? FETCH_TIMEOUT_MS} ms`)));
    }, o.timeoutMs ?? FETCH_TIMEOUT_MS);
    req.on('error', (e) => done(() => reject(e)));
    req.end();
  });
}
