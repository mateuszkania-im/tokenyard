import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { exportTraces, loadTraceRecords, parseDuration, pruneTraces } from './ledger/export.js';
import { renderReportTerminal } from './report/render-terminal.js';
import { buildReport, REPORT_DIMENSIONS, type ReportDimension } from './report/report.js';

const program = new Command();
program.name('tokenyard').description(pkg.description).version(pkg.version);
program
  .command('mock')
  .description('run the deterministic mock Anthropic provider')
  .option('--port <n>', 'port to listen on (0 picks a free one)', '0')
  .action(async (o: { port: string }) => {
    const { startAnthropicMock } = await import('./mock/anthropic.js');
    const mock = await startAnthropicMock({ port: Number(o.port) });
    console.log(mock.url);
    const stop = (): void => void mock.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
program
  .command('serve')
  .description('run the gateway')
  .option('--port <n>', 'port to listen on (0 picks a free one)', '4000')
  .option('--host <host>', 'address to bind', '127.0.0.1')
  .option('--base-path <path>', 'mount prefix stripped before path matching')
  .option(
    '--dev-upstream <url>',
    'development only: forward every Anthropic request to <url>, accepting the key ty_live_dev (upstream key from TOKENYARD_DEV_UPSTREAM_KEY, optional)',
  )
  .option('--policy <dir>', 'policy directory (policy.yaml, prices.yaml, keys.yaml), watched for changes')
  .option('--policy-url <url>', 'policy bundle URL (https), polled every 15 s with If-None-Match; redirects are errors')
  .option('--state-dir <dir>', 'where the last-known-good bundle is kept', '.tokenyard-state')
  .option('--candidate-policy <dir>', 'audit mode: a second policy directory whose decisions are traced but never enforced')
  .option('--experimental-subscription', 'experimental: accept keys with billing subscription and forward the user OAuth token (docs/experimental-subscription.md)')
  .option('--trace-dir <dir>', 'write NDJSON trace files under <dir>/<tenant>/<date>/<hour>.<instance>.ndjson')
  .option('--instance-id <id>', 'instance id in trace file names (default: 8 hex characters of a hash of hostname and start time)')
  .option('--trace-salt <salt>', 'HMAC salt for session, agent and prompt ids in traces (or TOKENYARD_TRACE_SALT); required with --trace-dir')
  .option('--store <kind>', 'counter store for budgets, rate limits, stream slots and taint: memory (one instance) or redis', 'memory')
  .option('--redis-url <url>', 'Redis URL for --store redis, for example redis://127.0.0.1:6379 (or TOKENYARD_REDIS_URL)')
  .action(async (o: { port: string; host: string; basePath?: string; devUpstream?: string; policy?: string; policyUrl?: string; stateDir: string; candidatePolicy?: string; experimentalSubscription?: boolean; traceDir?: string; instanceId?: string; traceSalt?: string; store: string; redisUrl?: string }) => {
    if (!o.devUpstream && !o.policy && !o.policyUrl) {
      console.error('tokenyard serve: give --policy <dir> or --policy-url <url> (or --dev-upstream <url> for development)');
      process.exit(1);
    }
    if ((o.policy || o.policyUrl) && o.devUpstream) {
      console.error('tokenyard serve: --dev-upstream cannot be combined with --policy or --policy-url');
      process.exit(1);
    }
    if (o.policy && o.policyUrl) {
      console.error('tokenyard serve: give --policy or --policy-url, not both');
      process.exit(1);
    }
    if (o.candidatePolicy && !o.policy && !o.policyUrl) {
      console.error('tokenyard serve: --candidate-policy needs --policy or --policy-url');
      process.exit(1);
    }
    if (o.store !== 'memory' && o.store !== 'redis') {
      console.error('tokenyard serve: --store must be memory or redis');
      process.exit(1);
    }
    const redisUrl = o.redisUrl ?? process.env.TOKENYARD_REDIS_URL;
    if (o.store === 'redis' && !redisUrl) {
      console.error('tokenyard serve: --store redis needs --redis-url or TOKENYARD_REDIS_URL');
      process.exit(1);
    }
    const traceSalt = o.traceSalt ?? process.env.TOKENYARD_TRACE_SALT;
    if (o.traceDir && !traceSalt) {
      console.error('tokenyard serve: --trace-dir needs --trace-salt or TOKENYARD_TRACE_SALT (session and agent ids are HMAC pseudonyms)');
      process.exit(1);
    }
    const { hostname } = await import('node:os');
    const { ulid } = await import('./edge/ulid.js');
    const { defaultInstanceId, TraceWriter } = await import('./ledger/writer.js');
    const instanceId = o.instanceId ?? defaultInstanceId(hostname(), Date.now());
    const writer = o.traceDir ? new TraceWriter({ dir: o.traceDir, instanceId, queueMax: 10_000, clock: Date.now }) : null;
    const { createGateway, DEFAULT_BODY_CAP_BYTES } = await import('./edge/server.js');
    let loader: import('./policy-loader/loader.js').PolicyLoader | null = null;
    let activePolicy: () => import('./policy/types.js').CompiledPolicy;
    if (o.devUpstream) {
      const { devPolicy, DEV_KEY, DEV_UPSTREAM_KEY_ENV } = await import('./edge/dev-policy.js');
      const dev = devPolicy({ upstream: o.devUpstream, keys: [DEV_KEY], credential: { env: DEV_UPSTREAM_KEY_ENV } });
      activePolicy = () => dev;
    } else {
      const { PolicyLoader } = await import('./policy-loader/loader.js');
      const l = new PolicyLoader({
        ...(o.policy ? { dir: o.policy } : {}),
        ...(o.policyUrl ? { url: o.policyUrl } : {}),
        ...(o.candidatePolicy ? { candidateDir: o.candidatePolicy } : {}),
        stateDir: o.stateDir,
        experimentalSubscription: o.experimentalSubscription === true,
      });
      l.on('error', (e: Error) => console.error(`tokenyard: policy load failed, keeping the active revision: ${e.message}`));
      l.on('loaded', (p: { revision: string }) => console.error(`tokenyard: policy revision ${p.revision} active`));
      try {
        await l.start();
      } catch (e) {
        console.error(`tokenyard serve: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      loader = l;
      activePolicy = () => l.active();
    }
    // Counter store: opened before the first request, seeded from the traces of the current windows (warm-up; a seed
    // never lowers spend), and swept every 30 s. The sweeper tick also writes the trace heartbeat (every second tick, 60 s).
    const { createGatewayRuntime } = await import('./edge/handler.js');
    const { openCounterStore, SWEEP_INTERVAL_MS, warmUpFromTraces } = await import('./limits/open-store.js');
    const { startSweeper } = await import('./limits/sweeper.js');
    const runtime = createGatewayRuntime();
    let counters: import('./limits/open-store.js').OpenedStore;
    try {
      counters = await openCounterStore({ kind: o.store, ...(redisUrl ? { redisUrl } : {}), instance: instanceId, onSwept: runtime.onSwept });
      if (o.traceDir) {
        const n = await warmUpFromTraces(counters.store, o.traceDir, activePolicy(), Date.now());
        if (n > 0) console.error(`tokenyard: warm-up seeded ${n} budget counter(s) from ${o.traceDir}`);
      }
    } catch (e) {
      console.error(`tokenyard serve: counter store: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    let ticks = 0;
    const stopSweeper = startSweeper(counters.store, {
      intervalMs: SWEEP_INTERVAL_MS,
      ...(counters.lock ? { lock: counters.lock } : {}),
      onTick: () => {
        if (++ticks % 2 === 0) writer?.heartbeat();
      },
      onError: (e) => console.error(`tokenyard: sweeper: ${e instanceof Error ? e.message : String(e)}`),
    });
    const gw = createGateway({
      policy: activePolicy,
      store: counters.store,
      runtime,
      traces: writer,
      traceSalt,
      clock: Date.now,
      newId: () => ulid(),
      basePath: o.basePath ?? null,
      bodyCapBytes: DEFAULT_BODY_CAP_BYTES,
      experimentalSubscription: o.experimentalSubscription === true,
    });
    console.log(await gw.listen(Number(o.port), o.host));
    const stop = (): void => {
      stopSweeper();
      void gw.close().then(() => loader?.stop()).then(() => writer?.close()).then(() => counters.close()).then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
program
  .command('env')
  .description('print shell code that sets repo, branch and ticket headers for Claude Code: eval "$(tokenyard env)"')
  .option('--ticket-pattern <regex>', 'regex applied to the branch name; the first group (or the whole match) is the ticket')
  .action(async (o: { ticketPattern?: string }) => {
    const { execFileSync } = await import('node:child_process');
    const { basename } = await import('node:path');
    const { buildEnvExport } = await import('./env.js');
    const git = (...args: string[]): string | null => {
      try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
      } catch {
        return null;
      }
    };
    const branch = git('symbolic-ref', '--short', 'HEAD') ?? git('rev-parse', '--short', 'HEAD');
    const top = git('rev-parse', '--show-toplevel');
    if (!branch || !top) {
      console.error('tokenyard env: not inside a git repository');
      process.exit(1);
    }
    const remote = git('remote', 'get-url', 'origin');
    const repo = (remote ?? top).replace(/\.git$/, '').split(/[/\\:]/).filter(Boolean).pop() ?? basename(top);
    process.stdout.write(buildEnvExport({ repo, branch, ticketPattern: o.ticketPattern ?? null, existing: process.env.ANTHROPIC_CUSTOM_HEADERS ?? null }));
  });
const keys = program.command('keys').description('manage tokenyard keys');
keys
  .command('create')
  .description('create a key: prints it once and appends its SHA-256 hash to keys.yaml')
  .requiredOption('--tenant <tenant>', 'tenant name')
  .requiredOption('--name <name>', 'key name, for example the developer')
  .option('--team <team>', 'team name')
  .option('--kind <kind>', 'developer or service', 'developer')
  .option('--billing <billing>', 'api or subscription', 'api')
  .option('--file <path>', 'keys file to append to', 'keys.yaml')
  .option('--experimental-subscription', 'allow --billing subscription (docs/experimental-subscription.md)')
  .action(async (o: { tenant: string; name: string; team?: string; kind: string; billing: string; file: string; experimentalSubscription?: boolean }) => {
    if (o.kind !== 'developer' && o.kind !== 'service') return void (console.error('tokenyard keys create: --kind must be developer or service'), process.exit(1));
    if (o.billing !== 'api' && o.billing !== 'subscription') return void (console.error('tokenyard keys create: --billing must be api or subscription'), process.exit(1));
    if (o.billing === 'subscription' && !o.experimentalSubscription) {
      console.error('tokenyard keys create: --billing subscription needs --experimental-subscription');
      process.exit(1);
    }
    const { appendKey, createKey } = await import('./edge/keys.js');
    const { plaintext, hash } = createKey();
    await appendKey(o.file, { hash, keyId: `key_${hash.slice(0, 8)}`, tenant: o.tenant, team: o.team ?? null, name: o.name, kind: o.kind, billing: o.billing });
    console.log(plaintext);
    console.error(`appended the hash to ${o.file}; the key is shown only once`);
  });
const policy = program.command('policy').description('policy files');
policy
  .command('check')
  .description('validate a policy directory: schema, then the semantic rules; exits 1 on errors')
  .argument('[dir]', 'policy directory (policy.yaml, prices.yaml, keys.yaml)', 'policy')
  .option('--experimental-subscription', 'allow the subscription passthrough items (docs/experimental-subscription.md)')
  .action(async (dir: string, o: { experimentalSubscription?: boolean }) => {
    const { loadPolicyDir } = await import('./policy-loader/load-dir.js');
    const { PolicyLoadError } = await import('./policy/load-dir.js');
    const { validatePolicy } = await import('./policy/validate.js');
    let errors: Array<{ code: string; path: string; message: string }>;
    let warnings: Array<{ code: string; path: string; message: string }> = [];
    try {
      const r = validatePolicy(await loadPolicyDir(dir), { experimentalSubscription: o.experimentalSubscription === true });
      ({ errors, warnings } = r);
    } catch (e) {
      if (!(e instanceof PolicyLoadError)) throw e;
      errors = e.issues;
    }
    for (const i of errors) console.log(`error ${i.code} ${i.path}: ${i.message}`);
    for (const i of warnings) console.log(`warning ${i.code} ${i.path}: ${i.message}`);
    console.log(`${errors.length} errors, ${warnings.length} warnings`);
    if (errors.length > 0) process.exit(1);
  });
policy
  .command('build')
  .description('write one bundle file (manifest, policy, prices, keys) from a policy directory; revision is GITHUB_SHA in CI, else the first 12 hex of the content sha256')
  .argument('[dir]', 'policy directory', 'policy')
  .option('--out <file>', 'output file', 'dist/policy-bundle.json')
  .option('--experimental-subscription', 'allow the subscription passthrough items (docs/experimental-subscription.md)')
  .action(async (dir: string, o: { out: string; experimentalSubscription?: boolean }) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const { loadPolicyDir } = await import('./policy-loader/load-dir.js');
    const { PolicyLoadError } = await import('./policy/load-dir.js');
    const { validatePolicy } = await import('./policy/validate.js');
    const { buildBundle, serializeBundle } = await import('./policy/bundle.js');
    try {
      const src = await loadPolicyDir(dir);
      const { errors } = validatePolicy(src, { experimentalSubscription: o.experimentalSubscription === true });
      if (errors.length > 0) {
        for (const i of errors) console.error(`error ${i.code} ${i.path}: ${i.message}`);
        process.exit(1);
      }
      const bundle = buildBundle(src, { createdAt: new Date().toISOString(), ...(process.env.GITHUB_SHA ? { revision: process.env.GITHUB_SHA.slice(0, 40) } : {}) });
      await mkdir(dirname(o.out), { recursive: true });
      await writeFile(o.out, serializeBundle(bundle));
      console.error(`wrote ${o.out}: revision ${bundle.manifest.revision}, sha256 ${bundle.manifest.sha256}`);
    } catch (e) {
      if (!(e instanceof PolicyLoadError)) throw e;
      for (const i of e.issues) console.error(`error ${i.code} ${i.path}: ${i.message}`);
      process.exit(1);
    }
  });
policy
  .command('schema')
  .description('print the JSON Schema of policy.yaml for editor completion: tokenyard policy schema > policy.schema.json')
  .action(async () => {
    const { policyJsonSchema } = await import('./policy/json-schema.js');
    process.stdout.write(`${JSON.stringify(policyJsonSchema(), null, 2)}\n`);
  });
const traces = program.command('traces').description('trace files written by serve --trace-dir');
const sinceOf = (v: string, now: number): number => (/^\d+[hd]$/.test(v) ? now - parseDuration(v) : Date.parse(v));
traces
  .command('export')
  .description('merge every instance file in a window into one ordered NDJSON file with a manifest line first')
  .requiredOption('--trace-dir <dir>', 'trace directory (shared storage when several instances write)')
  .requiredOption('--out <file>', 'output file; a name ending in .gz is gzipped')
  .option('--since <when>', 'duration such as 7d or 12h, or an ISO time', '7d')
  .option('--until <when>', 'ISO time (default now)')
  .option('--anonymize', 'replace tenant, team, key id, repo, branch and ticket with stable pseudonyms and drop client.version')
  .option('--salt <salt>', 'salt for --anonymize (or TOKENYARD_TRACE_SALT)')
  .action(async (o: { traceDir: string; out: string; since: string; until?: string; anonymize?: boolean; salt?: string }) => {
    const salt = o.salt ?? process.env.TOKENYARD_TRACE_SALT;
    if (o.anonymize && !salt) return void (console.error('tokenyard traces export: --anonymize needs --salt or TOKENYARD_TRACE_SALT'), process.exit(1));
    const now = Date.now();
    const sinceMs = sinceOf(o.since, now);
    const untilMs = o.until ? Date.parse(o.until) : now;
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return void (console.error('tokenyard traces export: --since and --until must be a duration or an ISO time'), process.exit(1));
    const m = await exportTraces({ dir: o.traceDir, sinceMs, untilMs, out: o.out, ...(o.anonymize && salt ? { anonymizeSalt: salt } : {}) });
    const gaps = m.instances.filter((i) => i.seqGaps > 0 || i.hoursWithoutFile.length > 0);
    console.error(`wrote ${o.out}: ${m.instances.reduce((n, i) => n + i.records, 0)} records from ${m.instances.length} instance(s)`);
    for (const i of gaps) console.error(`warning: instance ${i.id}: ${i.seqGaps} missing seq numbers, hours without a file: ${i.hoursWithoutFile.join(', ') || 'none'}`);
  });
traces
  .command('prune')
  .description('delete trace files older than a duration')
  .requiredOption('--trace-dir <dir>', 'trace directory')
  .requiredOption('--older-than <duration>', 'for example 30d')
  .action(async (o: { traceDir: string; olderThan: string }) => {
    const removed = await pruneTraces({ dir: o.traceDir, olderThanMs: parseDuration(o.olderThan), nowMs: Date.now() });
    console.error(`removed ${removed} file(s)`);
  });
program
  .command('report')
  .description('cost report from a trace dir or an export file')
  .requiredOption('--traces <path>', 'trace directory or an export file (.ndjson or .ndjson.gz)')
  .option('--by <dims>', 'comma list of tenant, team, key, repo, branch, ticket, session, requestClass, agent, promptId', 'team')
  .option('--since <when>', 'duration such as 7d, or an ISO time', '7d')
  .option('--until <when>', 'ISO time (default now)')
  .option('--tenant <tenant>', 'only this tenant')
  .action(async (o: { traces: string; by: string; since: string; until?: string; tenant?: string }) => {
    const dims = o.by.split(',').map((d) => d.trim()).filter(Boolean);
    const bad = dims.filter((d) => !REPORT_DIMENSIONS.includes(d as ReportDimension));
    if (bad.length > 0) return void (console.error(`tokenyard report: unknown dimension ${bad.join(', ')}`), process.exit(1));
    const now = Date.now();
    const records = await loadTraceRecords({ path: o.traces, sinceMs: sinceOf(o.since, now), untilMs: o.until ? Date.parse(o.until) : now, ...(o.tenant ? { tenant: o.tenant } : {}) });
    process.stdout.write(renderReportTerminal(buildReport(records, dims as ReportDimension[])));
  });
await program.parseAsync(process.argv);
