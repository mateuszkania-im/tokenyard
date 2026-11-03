#!/usr/bin/env node
// A throwaway local Redis for the Redis tests and benchmarks: a `redis:7` container that publishes only on a random
// 127.0.0.1 port and requires a random password (carried in the URL), removed when the caller is done, on exit and on
// SIGINT or SIGTERM. REDIS_URL, when set, is used instead and nothing is started.
//   node scripts/local-redis.mjs <command> [args...]   runs the command with REDIS_URL set, then removes the container
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** `docker run` arguments: loopback-only random host port, password required, no persistence. */
export function redisRunArgs(name, password) {
  return ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::6379', 'redis:7', 'redis-server', '--requirepass', password, '--save', '', '--appendonly', 'no'];
}

/** The host port from `docker port <name> 6379` output; refuses anything not bound to 127.0.0.1. */
export function hostPort(output) {
  const line = output.split('\n').find((l) => l.trim() !== '');
  const m = line ? /^127\.0\.0\.1:(\d+)$/.exec(line.trim()) : null;
  if (!m) throw new Error(`the Redis container is not published on loopback only: ${JSON.stringify(output.trim())}`);
  return Number(m[1]);
}

/** True when the URL's host is a loopback address (127.0.0.0/8, ::1 or localhost): only such a Redis may be flushed. */
export function isLoopbackRedisUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export const localRedisUrl = (port, password) => `redis://:${encodeURIComponent(password)}@127.0.0.1:${port}`;

/**
 * Starts the container (or takes REDIS_URL) and returns its URL and `stop`. `stop` is idempotent and is also run on
 * process exit, SIGINT and SIGTERM, so an interrupted run does not leave the container behind.
 */
export function startLocalRedis() {
  if (process.env.REDIS_URL) return { url: process.env.REDIS_URL, started: false, stop() {} };
  const name = `ty-redis-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  execFileSync('docker', redisRunArgs(name, password), { stdio: ['ignore', 'ignore', 'pipe'] });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  };
  const onSignal = (sig) => {
    stop();
    process.kill(process.pid, sig);
  };
  process.once('exit', stop);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const port = hostPort(execFileSync('docker', ['port', name, '6379'], { encoding: 'utf8' }));
    // Ready when it answers PING (the image takes a moment to accept connections).
    for (let i = 0; ; i++) {
      try {
        const out = execFileSync('docker', ['exec', '-e', `REDISCLI_AUTH=${password}`, name, 'redis-cli', 'ping'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (out.trim() === 'PONG') break;
      } catch {
        // not up yet
      }
      if (i >= 50) throw new Error('the Redis container did not answer PING');
      execFileSync('sleep', ['0.2']);
    }
    return { url: localRedisUrl(port, password), started: true, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: local-redis.mjs <command> [args...]');
    process.exit(2);
  }
  let redis;
  try {
    redis = startLocalRedis();
  } catch (e) {
    console.error(`local-redis: no REDIS_URL and the Redis container did not start: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    process.exit(1);
  }
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, REDIS_URL: redis.url } });
  child.on('exit', (code, signal) => {
    redis.stop();
    process.exit(code ?? (signal ? 1 : 0));
  });
}
