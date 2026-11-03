// Shared set-up for the security review C tests of the GitHub Action (C1 to C3): a git repository whose base commit
// holds the example policy and, as in .github/workflows/policy-replay.yml, the traces; a pull_request event for it.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Gh } from '../../src/action/main.js';

export const ROOT = join(import.meta.dirname, '..', '..');
export const TRACES = join(ROOT, 'examples/traces/demo.ndjson.gz');
export const HEAD_POLICY = readFileSync(join(ROOT, 'examples/policy-head/policy.yaml'), 'utf8');

export interface ActionRepo {
  tmp: string;
  repo: string;
  baseSha: string;
  /** Everything the Action wrote through console.log and console.error, one entry per call. */
  stdout: string[];
  stderr: string[];
  git(...args: string[]): string;
  env(o?: { fork?: boolean; traces?: string }): NodeJS.ProcessEnv;
  replayJson(): { requests: number; gates: { failed: string[] } };
  close(): void;
}

export function fakeGh(): { gh: Gh; created: string[] } {
  const created: string[] = [];
  return {
    created,
    gh: {
      listComments: async () => [],
      createComment: async (b: string) => void created.push(b),
      updateComment: async (_id: number, b: string) => void created.push(b),
    },
  };
}

export function actionRepo(): ActionRepo {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ty-c-action-')));
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  cpSync(join(ROOT, 'examples/policy'), join(repo, 'policy'), { recursive: true });
  mkdirSync(join(repo, 'traces'));
  cpSync(TRACES, join(repo, 'traces/demo.ndjson.gz'));
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void stdout.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.map(String).join(' ')));
  return {
    tmp,
    repo,
    baseSha,
    stdout,
    stderr,
    git,
    env(o = {}) {
      const event = join(tmp, 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: baseSha, repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: o.fork ? 'someone/r' : 'o/r', fork: o.fork === true } } } }));
      return {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_STEP_SUMMARY: join(tmp, 'summary.md'),
        GITHUB_OUTPUT: join(tmp, 'output.txt'),
        GITHUB_SHA: 'b'.repeat(40),
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_WORKSPACE: repo,
        RUNNER_TEMP: tmp,
        'INPUT_POLICY-DIR': join(repo, 'policy'),
        'INPUT_BASE-REF': 'main',
        INPUT_TRACES: o.traces ?? join(repo, 'traces/demo.ndjson.gz'),
        INPUT_COMMENT: 'true',
        INPUT_TOKEN: 'ghs_x',
      };
    },
    replayJson: () => JSON.parse(readFileSync(join(tmp, 'replay.json'), 'utf8')),
    close() {
      vi.restoreAllMocks();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
