// Spec 9.5 and 11: the GitHub Action (`tokenyard action`, started as the node24 `main` of action.yml). It reads policy
// files as data through the safe loader and git refs through the hardened replay-input path, and never executes
// anything that comes from the pull request. Fork PRs get the job summary only: no comment, no trace token, no API token.
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { checkPath, cliRoot, createWriteStreamUnder, isUnder, writeFileUnder } from '../fsutil/safe-path.js';
import { join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseDuration } from '../ledger/export.js';
import { loadPolicyDir } from '../policy-loader/load-dir.js';
import { compileReplaySource, copyFileAtCommit, loadPolicyAtCommit, locateRepoDir, openReplayTraces, resolveGitCommit } from '../policy-loader/replay-input.js';
import { PolicyLoadError, type PolicySource } from '../policy/load-dir.js';
import { validatePolicy } from '../policy/validate.js';
import { replay } from '../replay/engine.js';
import { renderJson } from '../replay/render-json.js';
import { COMMENT_MARKER, renderMarkdown } from '../replay/render-markdown.js';
import { escapeMarkdown, stripControls } from '../report/sanitize.js';

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
async function download(url: string, token: string | null, root: string, dest: string): Promise<void> {
  const u = new URL(url);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('traces URL must be https');
  const res = await fetch(u, { redirect: 'error', headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok || !res.body) throw new Error(`traces download failed with HTTP ${res.status}`);
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > MAX_TRACES_BYTES ? new Error('traces download is larger than 512 MiB') : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), cap, await createWriteStreamUnder(root, dest));
}

/**
 * One log line from text that may come from the pull request: line breaks, tabs and line or paragraph separators become
 * spaces and other control characters are dropped, and the legacy `##[command]` form gets a space (`## [`), so nothing
 * PR-controlled is a line the runner reads as a workflow command (C1). Every console write of the Action goes through this.
 */
const logLine = (s: string): string => stripControls(s.replace(/[\r\n\t\u2028\u2029]/g, ' ')).replace(/##\[/g, '## [');
const logError = (s: string): void => console.error(logLine(s));

/** sha256 of a file the replay reads, for the comment (C2). The caller has checked the path. */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
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
    logError(`tokenyard action: could not post the comment (${e instanceof Error ? e.message : String(e)}); the job summary has the result`);
  }
}

/**
 * Runs the Action; returns the exit code (1 when the policy check fails or a ci.failOn gate is exceeded). The runner
 * does not process workflow commands for the whole run: it starts with `::stop-commands::<random token>` and ends with
 * `::<token>::`, the only two lines that begin with `::` (C1). Outputs go through the GITHUB_OUTPUT file, never a command.
 */
export async function runAction(env: NodeJS.ProcessEnv, gh: Gh): Promise<number> {
  const token = randomBytes(16).toString('hex');
  console.log(`::stop-commands::${token}`);
  try {
    return await run(env, gh);
  } finally {
    console.log(`::${token}::`);
  }
}

async function run(env: NodeJS.ProcessEnv, gh: Gh): Promise<number> {
  try {
    const event = await readEvent(env);
    // Fail closed: a pull request event whose payload cannot be read is treated as a fork.
    const fork = event === null ? (env.GITHUB_EVENT_NAME ?? '').startsWith('pull_request') : event.fork;
    const wantComment = input(env, 'comment') !== 'false';
    const headDir = input(env, 'policy-dir') || 'policy';
    const baseRef = input(env, 'base-ref') || env.GITHUB_BASE_REF || '';
    const tracesInput = input(env, 'traces');
    if (tracesInput === '') throw new Error('the traces input is required');
    const repo = locateRepoDir(headDir, env.GITHUB_WORKSPACE ? env.GITHUB_WORKSPACE : null);
    // Every path the PR tree can shape is read below the workspace with no symbolic link on the way (S-FS-1).
    const inWorkspace = env.GITHUB_WORKSPACE ? { root: env.GITHUB_WORKSPACE } : {};
    // The trace token is read only outside fork PRs.
    const tracesToken = fork ? '' : input(env, 'traces-token');
    const headRev = (event?.headSha ?? env.GITHUB_SHA ?? 'head').slice(0, 7);

    // 1. policy check on the head, data only. The files are read and parsed once, for the check and for the replay.
    let errors: Array<{ code: string; path: string; message: string }> = [];
    let warnings: Array<{ code: string; path: string; message: string }> = [];
    let headSrc: PolicySource | null = null;
    try {
      headSrc = await loadPolicyDir(headDir, inWorkspace);
      ({ errors, warnings } = validatePolicy(headSrc, { experimentalSubscription: false }));
    } catch (e) {
      if (!(e instanceof PolicyLoadError)) throw e;
      errors = e.issues.map((i) => ({ code: e.code, path: i.path, message: i.message }));
    }
    if (errors.length > 0 || headSrc === null) {
      for (const i of errors) logError(`error ${i.code} ${i.path}: ${i.message}`);
      const body = [COMMENT_MARKER, '### tokenyard policy replay', '', `Policy check failed: ${errors.length} error${errors.length === 1 ? '' : 's'}. Replay did not run.`, '', ...errors.slice(0, 20).map((i) => `- ${escapeMarkdown(i.code)} ${escapeMarkdown(i.path)}: ${escapeMarkdown(i.message, 400)}`), ''].join('\n');
      await publish(env, gh, body, wantComment, fork);
      return 1;
    }

    // 2. the base: a git object read from the explicit repository at the workspace. In a pull request it is the
    // event's base commit and nothing else; the base-ref input is resolved as a git ref only for other events.
    const isPr = (env.GITHUB_EVENT_NAME ?? '').startsWith('pull_request');
    const candidates = isPr ? [event?.baseSha ?? ''] : [baseRef, `origin/${baseRef}`];
    const commit = candidates.map((c) => resolveGitCommit(c, repo)).find((c) => c !== null);
    if (!commit) throw new Error(isPr ? 'the pull request base commit is missing from the event or from the checkout (use actions/checkout with fetch-depth: 0)' : `base-ref ${JSON.stringify(baseRef)} is not a git ref (fetch the base branch)`);

    // 3. traces: a URL fetched with the traces token (never in a fork PR); in a pull request, a path in the workspace
    // as committed at the base commit (C2: the PR cannot rewrite the traces that judge it); otherwise the path as given.
    const work = env.RUNNER_TEMP || process.cwd();
    let tracesPath = tracesInput;
    let tracesRoot: { root?: string } = inWorkspace;
    let tracesSha256: string;
    let tracesSource: string | undefined;
    const gz = (p: string): string => (p.endsWith('.gz') ? 'traces.ndjson.gz' : 'traces.ndjson');
    if (/^https?:\/\//i.test(tracesInput)) {
      tracesPath = join(work, gz(new URL(tracesInput).pathname));
      tracesRoot = { root: work };
      await download(tracesInput, tracesToken === '' ? null : tracesToken, work, tracesPath);
      tracesSha256 = await fileSha256(tracesPath);
    } else if (env.GITHUB_WORKSPACE && isUnder(env.GITHUB_WORKSPACE, tracesPath) && isPr) {
      // No symbolic link on the way in the checkout either (S-FS-1), although the working-tree file is never read.
      await checkPath(env.GITHUB_WORKSPACE, tracesPath).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      });
      const rel = relative(resolve(env.GITHUB_WORKSPACE), resolve(tracesPath)).split(sep).join('/');
      tracesPath = join(work, `base-${gz(tracesInput)}`);
      tracesRoot = { root: work };
      tracesSha256 = await copyFileAtCommit({ commit, path: rel, repo, root: work, dest: tracesPath, maxBytes: MAX_TRACES_BYTES });
      tracesSource = `${rel} at the base commit`;
    } else {
      if (env.GITHUB_WORKSPACE && !isUnder(env.GITHUB_WORKSPACE, tracesPath)) tracesRoot = {};
      await checkPath(tracesRoot.root ?? cliRoot(tracesPath), tracesPath);
      tracesSha256 = await fileSha256(tracesPath);
    }

    // 4. replay
    const sinceInput = input(env, 'since');
    const sinceMs = sinceInput === '' ? null : /^\d+[hd]$/.test(sinceInput) ? Date.now() - parseDuration(sinceInput) : Date.parse(sinceInput);
    if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error('the since input must be a duration such as 7d, or an ISO time');
    const head = compileReplaySource(headSrc, { experimentalSubscription: false });
    const base = loadPolicyAtCommit({ commit, repo, experimentalSubscription: false });
    const result = await replay({ base, head, traces: await openReplayTraces([tracesPath], tracesRoot), sinceMs, tenant: null });

    // 5. outputs: replay.json for the artifact step, the sticky comment, the job summary
    const jsonPath = join(work, 'replay.json');
    await writeFileUnder(work, jsonPath, renderJson(result));
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `replay-json=${jsonPath}\n`);
    const baseRev = event?.baseSha?.slice(0, 7) ?? baseRef;
    const body = renderMarkdown(result, { baseRev, headRev, checkSummary: { errors: errors.length, warnings: warnings.length }, tracesSha256, ...(tracesSource === undefined ? {} : { tracesSource }) });
    await publish(env, gh, body, wantComment, fork);
    if (result.gates.failed.length === 0) return 0;
    logError(`tokenyard action: check failed: ${result.gates.failed.join(', ')}; the pull request comment and the job summary have the details`);
    return 1;
  } catch (e) {
    logError(`tokenyard action: ${e instanceof Error ? e.message : String(e)}`);
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
  let me: string | null = null;
  /** GITHUB_TOKEN (and app tokens) cannot read /user and comment as github-actions[bot]; a personal token answers with its login. */
  const identity = async (): Promise<string> => {
    if (me === null) {
      try {
        const u = (await call('GET', '/user')) as { login?: string } | null;
        me = u?.login ?? 'github-actions[bot]';
      } catch {
        me = 'github-actions[bot]';
      }
    }
    return me;
  };
  return {
    async listComments() {
      const { repo, pr } = await target();
      const me = await identity();
      const out: Array<{ id: number; body: string }> = [];
      for (let page = 1; page <= 20; page++) {
        const rows = (await call('GET', `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`)) as Array<{ id: number; body?: string; user?: { login?: string } | null }>;
        // Only comments written by the token's own identity: a marker in someone else's comment is not ours to edit.
        for (const r of rows) if (r.user?.login === me && (r.body ?? '').startsWith(COMMENT_MARKER)) out.push({ id: r.id, body: r.body ?? '' });
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
