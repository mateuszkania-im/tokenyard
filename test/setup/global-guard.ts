// Vitest global setup: the directory the process guard (process-guard.ts, child-listen-guard.mjs) writes to, and the
// final check. The run fails when a test file leaked a child, when anything a test started listened on every
// interface, or when a child a test started was not seen exiting and is still alive at the end (a worker that died
// before its afterAll).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

export interface LeftoverOptions {
  /** Defaults to process.platform (tests of the Windows path set it). */
  platform?: NodeJS.Platform;
  /** The image name running under a pid on Windows (tasklist), or null when none; tests replace it. */
  imageOf?: (pid: number) => string | null;
  /** SIGKILL a child still alive (POSIX only; Windows never kills). Default true. */
  kill?: boolean;
}

/** The image name (for example node.exe) of a Windows pid, from tasklist; null when no process has it. */
function tasklistImage(pid: number): string | null {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim();
    const m = /^"([^"]+)","(\d+)"/.exec(out);
    return m && Number(m[2]) === pid ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** True when the pid runs and its command line (POSIX) or image name (Windows) still matches the one recorded. */
function stillRunning(pid: number, cmd: string, o: Required<LeftoverOptions>): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (o.platform === 'win32') {
    // kill(pid, 0) only says some process has the pid; tasklist gives its image, compared with the recorded command.
    const image = o.imageOf(pid)?.toLowerCase().replace(/\.exe$/, '');
    return image !== undefined && image !== '' && cmd.toLowerCase().includes(image);
  }
  try {
    const now = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const first = cmd.split(' ').slice(1, 3).join(' ');
    return now !== '' && (first === '' || now.includes(first));
  } catch {
    return false;
  }
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

/**
 * The problems the workers recorded in `dir`: leaks, wildcard listeners, and recorded children still alive. A pid the
 * worker saw exit (exited-*.txt) is skipped, once per exit: another process may have it by now. On POSIX a child
 * still alive is killed; on Windows it is reported only, because an image name match does not prove it is ours.
 */
export function leftovers(dir: string, options: LeftoverOptions = {}): string[] {
  const o: Required<LeftoverOptions> = { platform: process.platform, imageOf: tasklistImage, kill: true, ...options };
  const files = readdirSync(dir);
  const exits = new Map<string, number>();
  for (const f of files.filter((n) => n.startsWith('exited-'))) {
    for (const pid of lines(readFileSync(join(dir, f), 'utf8'))) exits.set(pid, (exits.get(pid) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (f === 'leaks.txt') out.push(...lines(text));
    else if (f.startsWith('wildcard-')) out.push(...lines(text).map((l) => `child listener bound to every interface: ${l}`));
    else if (f.startsWith('spawned-')) {
      for (const line of lines(text)) {
        const [pid = '', cmd = ''] = line.split('\t');
        const seen = exits.get(pid) ?? 0;
        if (seen > 0) {
          exits.set(pid, seen - 1);
          continue;
        }
        if (!stillRunning(Number(pid), cmd, o)) continue;
        if (o.platform === 'win32') {
          out.push(`child still alive at the end of the run (not killed on Windows): pid ${pid}: ${cmd}`);
          continue;
        }
        out.push(`child still alive at the end of the run: pid ${pid}: ${cmd}`);
        if (o.kill) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {
            // gone meanwhile
          }
        }
      }
    }
  }
  return out;
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'ty-process-guard-'));
  project.provide('processGuardDir', dir);
  return () => {
    const found = leftovers(dir);
    rmSync(dir, { recursive: true, force: true });
    if (found.length > 0) throw new Error(`process guard: ${found.length} problem(s)\n${found.join('\n')}`);
  };
}
