// Spec 9.5 and 11: the GitHub Action (`tokenyard action`, started as the node24 `main` of action.yml). It reads policy
// files as data through the safe loader and git refs through the hardened replay-input path, and never executes
// anything that comes from the pull request. Fork PRs get the job summary only: no comment, no trace token, no API token.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseDuration } from '../ledger/export.js';
import { loadPolicyDir } from '../policy-loader/load-dir.js';
import { loadReplayPolicy, openReplayTraces } from '../policy-loader/replay-input.js';
import { PolicyLoadError } from '../policy/load-dir.js';
import { validatePolicy } from '../policy/validate.js';
import { replay } from '../replay/engine.js';
import { renderJson } from '../replay/render-json.js';
import { COMMENT_MARKER, renderMarkdown } from '../replay/render-markdown.js';
import { escapeMarkdown } from '../report/sanitize.js';

export interface Gh {
  listComments(): Promise<Array<{ id: number; body: string }>>;
  createComment(b: string): Promise<void>;
  updateComment(id: number, b: string): Promise<void>;
}

const MAX_COMMENT = 60_000;
const MAX_TRACES_BYTES = 512 * 1024 * 1024;

const input = (env: NodeJS.ProcessEnv, name: string): string => (env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] ?? '').trim();

interface PullRequestEvent {
  number: number;
  baseSha: string | null;
  headSha: string | null;
  fork: boolean;
}

/** The pull request of the triggering event; a missing or unreadable event file means no pull request. Data only. */
async function readEvent(env: NodeJS.ProcessEnv): Promise<PullRequestEvent | null> {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const ev = JSON.parse(await readFile(path, 'utf8')) as { pull_request?: { number?: number; base?: { sha?: string; repo?: { full_name?: string } }; head?: { sha?: string; repo?: { full_name?: string; fork?: boolean } | null } } };
    const pr = ev.pull_request;
    if (!pr) return null;
    const headRepo = pr.head?.repo;
    // A deleted fork has no head repo: treat as fork. Anything that differs from the base repository is a fork.
    const fork = headRepo == null || headRepo.fork === true || (pr.base?.repo?.full_name !== undefined && headRepo.full_name !== pr.base.repo.full_name);
    return { number: pr.number ?? 0, baseSha: pr.base?.sha ?? null, headSha: pr.head?.sha ?? null, fork };
  } catch {
    return null;
  }
}

/** Downloads `url` to `dest` (https, or http to loopback for tests), with a size cap. The bearer token is sent only when given. */
async function download(url: string, token: string | null, dest: string): Promise<void> {
  const u = new URL(url);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('traces URL must be https');
  const res = await fetch(u, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok || !res.body) throw new Error(`traces download failed with HTTP ${res.status}`);
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > MAX_TRACES_BYTES ? new Error('traces download is larger than 512 MiB') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(dest));
}

function clip(body: string): string {
  if (body.length <= MAX_COMMENT) return body;
  return `${body.slice(0, MAX_COMMENT)}\n\n</details>\n\n(comment cut at ${MAX_COMMENT} characters; the full result is in replay.json)\n`;
}

async function publish(env: NodeJS.ProcessEnv, gh: Gh, body: string, wantComment: boolean, fork: boolean): Promise<void> {
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, `${body}\n`);
  if (!wantComment || fork) return;
  try {
    const existing = (await gh.listComments()).find((c) => c.body.startsWith(COMMENT_MARKER));
    if (existing) await gh.updateComment(existing.id, clip(body));
    else await gh.createComment(clip(body));
  } catch (e) {
    console.error(`tokenyard action: could not post the comment (${e instanceof Error ? e.message : String(e)}); the job summary has the result`);
  }
}

/** Runs the Action; returns the exit code (1 when the policy check fails or a ci.failOn gate is exceeded). */
export async function runAction(env: NodeJS.ProcessEnv, gh: Gh): Promise<number> {
  try {
    const event = await readEvent(env);
    const fork = event?.fork ?? false;
    const wantComment = input(env, 'comment') !== 'false';
    const headDir = input(env, 'policy-dir') || 'policy';
    const baseRef = input(env, 'base-ref') || env.GITHUB_BASE_REF || '';
    const tracesInput = input(env, 'traces');
    if (tracesInput === '') throw new Error('the traces input is required');
    if (baseRef === '') throw new Error('base-ref is empty and this is not a pull request event');
    // The trace token is read only outside fork PRs.
    const tracesToken = fork ? '' : input(env, 'traces-token');
    const headRev = (event?.headSha ?? env.GITHUB_SHA ?? 'head').slice(0, 7);

    // 1. policy check on the head, data only
    let errors: Array<{ code: string; path: string; message: string }> = [];
    let warnings: Array<{ code: string; path: string; message: string }> = [];
    try {
      ({ errors, warnings } = validatePolicy(await loadPolicyDir(headDir), { experimentalSubscription: false }));
    } catch (e) {
      if (!(e instanceof PolicyLoadError)) throw e;
      errors = e.issues.map((i) => ({ code: e.code, path: i.path, message: i.message }));
    }
    if (errors.length > 0) {
      for (const i of errors) console.error(`error ${i.code} ${i.path}: ${i.message}`);
      const body = [COMMENT_MARKER, '### tokenyard policy replay', '', `Policy check failed: ${errors.length} error${errors.length === 1 ? '' : 's'}. Replay did not run.`, '', ...errors.slice(0, 20).map((i) => `- ${escapeMarkdown(i.code)} ${escapeMarkdown(i.path)}: ${escapeMarkdown(i.message, 400)}`), ''].join('\n');
      await publish(env, gh, body, wantComment, fork);
      return 1;
    }

    // 2. traces: a local path, or a URL fetched with the traces token (never in a fork PR)
    const work = env.RUNNER_TEMP || process.cwd();
    let tracesPath = tracesInput;
    if (/^https?:\/\//i.test(tracesInput)) {
      tracesPath = join(work, new URL(tracesInput).pathname.endsWith('.gz') ? 'traces.ndjson.gz' : 'traces.ndjson');
      await mkdir(dirname(tracesPath), { recursive: true });
      await download(tracesInput, tracesToken === '' ? null : tracesToken, tracesPath);
    }

    // 3. replay
    const sinceInput = input(env, 'since');
    const sinceMs = sinceInput === '' ? null : /^\d+[hd]$/.test(sinceInput) ? Date.now() - parseDuration(sinceInput) : Date.parse(sinceInput);
    if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error('the since input must be a duration such as 7d, or an ISO time');
    const head = await loadReplayPolicy({ source: headDir, headDir, experimentalSubscription: false });
    let base;
    try {
      base = await loadReplayPolicy({ source: baseRef, headDir, experimentalSubscription: false });
    } catch (e) {
      // actions/checkout leaves the base branch as origin/<name>
      if (baseRef.includes('/')) throw e;
      base = await loadReplayPolicy({ source: `origin/${baseRef}`, headDir, experimentalSubscription: false });
    }
    const result = await replay({ base, head, traces: await openReplayTraces([tracesPath]), sinceMs, tenant: null });

    // 4. outputs: replay.json for the artifact step, the sticky comment, the job summary
    const jsonPath = join(work, 'replay.json');
    await writeFile(jsonPath, renderJson(result));
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `replay-json=${jsonPath}\n`);
    const baseRev = event?.baseSha?.slice(0, 7) ?? baseRef;
    const body = renderMarkdown(result, { baseRev, headRev, checkSummary: { errors: errors.length, warnings: warnings.length } });
    await publish(env, gh, body, wantComment, fork);
    return result.gates.failed.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(`tokenyard action: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** GitHub REST over fetch with the `token` input. The token is read on first use and never logged. */
export function githubClient(env: NodeJS.ProcessEnv): Gh {
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const token = input(env, 'token');
    if (token === '') throw new Error('the token input is empty');
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'tokenyard-action', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path} answered HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const target = async (): Promise<{ repo: string; pr: number }> => {
    const repo = env.GITHUB_REPOSITORY ?? '';
    const pr = (await readEvent(env))?.number ?? 0;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || pr <= 0) throw new Error('not a pull request event');
    return { repo, pr };
  };
  return {
    async listComments() {
      const { repo, pr } = await target();
      const out: Array<{ id: number; body: string }> = [];
      for (let page = 1; page <= 20; page++) {
        const rows = (await call('GET', `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`)) as Array<{ id: number; body?: string }>;
        for (const r of rows) out.push({ id: r.id, body: r.body ?? '' });
        if (rows.length < 100) break;
      }
      return out;
    },
    async createComment(body) {
      const { repo, pr } = await target();
      await call('POST', `/repos/${repo}/issues/${pr}/comments`, { body });
    },
    async updateComment(id, body) {
      const { repo } = await target();
      await call('PATCH', `/repos/${repo}/issues/comments/${id}`, { body });
    },
  };
}
