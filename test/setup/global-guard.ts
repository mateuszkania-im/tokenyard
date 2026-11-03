// Vitest global setup: the directory the process guard (process-guard.ts, child-listen-guard.mjs) writes to, and the
// final check. The run fails when a test file leaked a child, when anything a test started listened on every
// interface, or when a child a test started is still alive at the end (a worker that died before its afterAll).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

/** True when the pid runs and its command line still matches the one recorded (pids are reused). */
function stillRunning(pid: number, cmd: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const now = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const first = cmd.split(' ').slice(1, 3).join(' ');
    return now !== '' && (first === '' || now.includes(first));
  } catch {
    return false;
  }
}

export function leftovers(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    if (f === 'leaks.txt') out.push(...text.split('\n').filter(Boolean));
    else if (f.startsWith('wildcard-')) out.push(...text.split('\n').filter(Boolean).map((l) => `child listener bound to every interface: ${l}`));
    else if (f.startsWith('spawned-')) {
      for (const line of text.split('\n').filter(Boolean)) {
        const [pid, cmd = ''] = line.split('\t');
        if (stillRunning(Number(pid), cmd)) {
          out.push(`child still alive at the end of the run: pid ${pid}: ${cmd}`);
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
