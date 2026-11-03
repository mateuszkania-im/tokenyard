import { Command } from 'commander';
import { description, version } from '../package.json';
import { exportTraces, loadTraceRecords, parseDuration, pruneTraces } from './ledger/export.js';
import { renderReportTerminal } from './report/render-terminal.js';
import { buildReport, REPORT_DIMENSIONS, type ReportDimension } from './report/report.js';

/**
 * A secret from `--<flag>-file <path>` or the environment variable `env` (B5): the value given as `--<flag>` itself is
 * refused, because every local user reads command lines with `ps` and shells keep them in history. `allowFlag` keeps
 * a flag value that holds no secret (a Redis URL without a password).
 */
async function secretInput(cmd: string, o: { flag: string; value?: string; file?: string; env: string; allowFlag?: (v: string) => boolean }): Promise<string | undefined> {
  if (o.value !== undefined && o.allowFlag?.(o.value) !== true) {
    console.error(`${cmd}: --${o.flag} puts a secret on the command line, where every local user can read it (ps); set ${o.env} or use --${o.flag}-file <path>`);
    process.exit(1);
  }
  if (o.value !== undefined && o.file !== undefined) {
    console.error(`${cmd}: give --${o.flag} or --${o.flag}-file, not both`);
    process.exit(1);
  }
  if (o.file !== undefined) {
    const { cliRoot, readFileUnder } = await import('./fsutil/safe-path.js');
    const raw = await readFileUnder(cliRoot(o.file), o.file, 4096).catch((e: unknown) => {
      console.error(`${cmd}: --${o.flag}-file: ${e instanceof Error ? e.message : String(e)}`);
      return process.exit(1);
    });
    const v = raw?.toString('utf8').replace(/\r?\n$/, '');
    if (!v) {
      console.error(`${cmd}: --${o.flag}-file ${o.file} is empty or missing`);
      process.exit(1);
    }
    return v;
  }
  return o.value ?? (process.env[o.env] || undefined);
}

const hasPassword = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.password !== '' || u.username !== '';
  } catch {
    return true; // unparsable: treat as secret rather than echo it back
  }
};

const program = new Command();
program.name('tokenyard').description(description).version(version);
program
  .command('mock')
  .description('run the deterministic mock Anthropic provider (and with --openai-port the OpenAI one)')
  .option('--port <n>', 'port to listen on (0 picks a free one)', '0')
  .option('--host <host>', 'address to bind (the compose demo uses 0.0.0.0 inside its container)', '127.0.0.1')
  .option('--openai-port <n>', 'also run the mock OpenAI provider on this port')
  .action(async (o: { port: string; host: string; openaiPort?: string }) => {
    const { startAnthropicMock } = await import('./mock/anthropic.js');
    // Nothing reads the requests a standalone mock receives, so it keeps none (V2: they held every body sent).
    const mock = await startAnthropicMock({ port: Number(o.port), host: o.host, keepReceived: 0 });
    const openai = o.openaiPort === undefined ? null : await (await import('./mock/openai.js')).startOpenAIMock({ port: Number(o.openaiPort), host: o.host, keepReceived: 0 });
    console.log(mock.url);
    if (openai) console.log(openai.url);
    const stop = (): void => void Promise.all([mock.close(), openai?.close()]).then(() => process.exit(0));
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
  .option('--trace-salt-file <path>', 'file holding the HMAC salt for session, agent and prompt ids in traces (or TOKENYARD_TRACE_SALT); required with --trace-dir')
  .option('--trace-salt <salt>', 'refused: a salt on the command line is visible to every local user; use TOKENYARD_TRACE_SALT or --trace-salt-file')
  .option('--otlp-endpoint <url>', 'export OTel GenAI spans to this OTLP/HTTP endpoint (or OTEL_EXPORTER_OTLP_ENDPOINT); needs a trace salt')
  .option('--metrics-port <n>', 'ops listener with /metrics (never served on --port), /healthz and /readyz; 0 disables it', '9464')
  .option('--metrics-host <host>', 'address the ops listener binds; a non-loopback address needs a metrics token', '127.0.0.1')
  .option('--metrics-token-file <path>', 'file holding the bearer token /metrics requires (or TOKENYARD_METRICS_TOKEN); required when --metrics-host is not loopback')
  .option('--metrics-token <token>', 'refused: a token on the command line is visible to every local user; use TOKENYARD_METRICS_TOKEN or --metrics-token-file')
  .option('--no-metrics', 'do not start the ops listener')
  .option('--store <kind>', 'counter store for budgets, rate limits, stream slots and taint: memory (one instance) or redis', 'memory')
  .option('--redis-url <url>', 'Redis URL for --store redis without credentials, for example redis://127.0.0.1:6379; a URL with a password goes in TOKENYARD_REDIS_URL or --redis-url-file')
  .option('--redis-url-file <path>', 'file holding the Redis URL (with its password)')
  .action(async (o: { port: string; host: string; basePath?: string; devUpstream?: string; policy?: string; policyUrl?: string; stateDir: string; candidatePolicy?: string; experimentalSubscription?: boolean; traceDir?: string; instanceId?: string; traceSalt?: string; traceSaltFile?: string; store: string; redisUrl?: string; redisUrlFile?: string; otlpEndpoint?: string; metricsPort: string; metricsHost: string; metricsToken?: string; metricsTokenFile?: string; metrics: boolean }) => {
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
    const cmd = 'tokenyard serve';
    const redisUrl = await secretInput(cmd, { flag: 'redis-url', value: o.redisUrl, file: o.redisUrlFile, env: 'TOKENYARD_REDIS_URL', allowFlag: (v) => !hasPassword(v) });
    if (o.store === 'redis' && !redisUrl) {
      console.error('tokenyard serve: --store redis needs --redis-url, --redis-url-file or TOKENYARD_REDIS_URL');
      process.exit(1);
    }
    const traceSalt = await secretInput(cmd, { flag: 'trace-salt', value: o.traceSalt, file: o.traceSaltFile, env: 'TOKENYARD_TRACE_SALT' });
    // The guardrail HMAC salt is the trace salt whenever one is set: taint written by one instance must match on another.
    if (o.store === 'redis' && !traceSalt) {
      console.error('tokenyard serve: --store redis needs TOKENYARD_TRACE_SALT or --trace-salt-file (a stable salt, so session taint HMACs match across instances and restarts)');
      process.exit(1);
    }
    if (o.traceDir && !traceSalt) {
      console.error('tokenyard serve: --trace-dir needs TOKENYARD_TRACE_SALT or --trace-salt-file (session and agent ids are HMAC pseudonyms)');
      process.exit(1);
    }
    const otlpEndpoint = o.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
    if (otlpEndpoint !== null && !/^https?:\/\/[^\s]+$/.test(otlpEndpoint)) {
      console.error('tokenyard serve: --otlp-endpoint must be an http:// or https:// URL');
      process.exit(1);
    }
    if (otlpEndpoint !== null && !traceSalt) {
      console.error('tokenyard serve: --otlp-endpoint needs TOKENYARD_TRACE_SALT or --trace-salt-file (session and agent ids on spans are HMAC pseudonyms)');
      process.exit(1);
    }
    if (!/^\d+$/.test(o.metricsPort)) {
      console.error('tokenyard serve: --metrics-port must be a port number');
      process.exit(1);
    }
    const opsOn = o.metrics && Number(o.metricsPort) !== 0;
    const metricsToken = await secretInput(cmd, { flag: 'metrics-token', value: o.metricsToken, file: o.metricsTokenFile, env: 'TOKENYARD_METRICS_TOKEN' });
    const { isLoopbackHost } = await import('./edge/ops.js');
    if (opsOn && !isLoopbackHost(o.metricsHost) && !metricsToken) {
      console.error('tokenyard serve: --metrics-host is not a loopback address, so TOKENYARD_METRICS_TOKEN or --metrics-token-file is required (or use --no-metrics)');
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
    const { createMetrics, registerCollectors } = await import('./telemetry/metrics.js');
    const { createTracer } = await import('./telemetry/otel.js');
    const metrics = createMetrics();
    const spans = await createTracer(otlpEndpoint); // loads the OpenTelemetry packages only when an endpoint is set
    registerCollectors(metrics, {
      revision: () => activePolicy().revision,
      candidateRevision: () => activePolicy().candidate?.revision ?? null,
      ...(loader ? { loadErrors: () => (loader as import('./policy-loader/loader.js').PolicyLoader).loadErrors } : {}),
      ...(writer ? { traceDrops: () => writer.dropped } : {}),
    });
    let counters: import('./limits/open-store.js').OpenedStore;
    try {
      counters = await openCounterStore({ kind: o.store, ...(redisUrl ? { redisUrl } : {}), instance: instanceId, onSwept: (ids) => {
          runtime.onSwept(ids);
          metrics.inc('tokenyard_swept_total', {}, ids.length);
        } });
      if (o.traceDir) {
        const n = await warmUpFromTraces(counters.store, o.traceDir, activePolicy(), Date.now());
        if (n > 0) console.error(`tokenyard: warm-up seeded ${n} budget counter(s) from ${o.traceDir}`);
      }
    } catch (e) {
      console.error(`tokenyard serve: counter store: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    if (!o.devUpstream) {
      // Restart loses memory-store spend without warm-up; an unset provider key is a 401 per request (FR-I2, FR-M7).
      // The development upstream key is optional, so --dev-upstream gets neither.
      const { startupWarnings } = await import('./edge/startup-warnings.js');
      for (const w of startupWarnings(activePolicy(), { store: o.store, traceDir: o.traceDir !== undefined, env: process.env })) console.error(w);
    }
    let ticks = 0;
    const stopSweeper = startSweeper(counters.store, {
      intervalMs: SWEEP_INTERVAL_MS,
      ...(counters.lock ? { lock: counters.lock } : {}),
      onTick: () => {
        if (++ticks % 2 === 0) writer?.heartbeat();
      },
      onError: (e) => {
        metrics.inc('tokenyard_sweeper_errors_total');
        console.error(`tokenyard: sweeper: ${e instanceof Error ? e.message : String(e)}`);
      },
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
      metrics,
      ...(otlpEndpoint !== null ? { spans } : {}),
      ...(metricsToken ? { metricsToken } : {}),
    });
    const apiUrl = await gw.listen(Number(o.port), o.host);
    if (opsOn) {
      try {
        console.error(`tokenyard: ops listener ${await gw.listenOps(Number(o.metricsPort), o.metricsHost)} (/metrics${metricsToken ? ', bearer token required' : ''}, /healthz, /readyz)`);
      } catch (e) {
        console.error(`tokenyard serve: ops listener on ${o.metricsHost}:${o.metricsPort}: ${e instanceof Error ? e.message : String(e)} (use --metrics-port or --no-metrics)`);
        process.exit(1);
      }
    }
    console.log(apiUrl); // printed last: by then both listeners are up
    const stop = (): void => {
      stopSweeper();
      void gw.close().then(() => loader?.stop()).then(() => writer?.close()).then(() => spans.shutdown().catch(() => undefined)).then(() => counters.close()).then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
program
  .command('demo')
  .description('one-process demo: synthetic coding-agent traffic through the gateway, then a replay of the demo PR policy change')
  .option('--seed <n>', 'seed of the traffic generator; the same seed gives byte-identical traces', '1')
  .option('--write-traces <file>', 'also write the recorded traces as an export file (a name ending in .gz is gzipped)')
  .action(async (o: { seed: string; writeTraces?: string }) => {
    const seed = Number(o.seed);
    if (!Number.isInteger(seed)) return void (console.error('tokenyard demo: --seed must be an integer'), process.exit(1));
    const { runDemo } = await import('./demo/run.js');
    await runDemo({ out: process.stdout, seed, ...(o.writeTraces ? { writeTraces: o.writeTraces } : {}) });
  });
program
  .command('traffic')
  .description('send the synthetic demo traffic (the 8 demo developers, public demo keys) to running gateways, in turn; for the compose demo')
  .requiredOption('--gateway-url <url...>', 'gateway base URL(s); with several, requests alternate between them')
  .option('--seed <n>', 'seed of the traffic generator', '1')
  .option('--days <n>', 'days of traffic to send (sent back to back, not in real time)', '1')
  .action(async (o: { gatewayUrl: string[]; seed: string; days: string }) => {
    const seed = Number(o.seed);
    const days = Number(o.days);
    if (!Number.isInteger(seed) || !Number.isInteger(days) || days < 1) return void (console.error('tokenyard traffic: --seed and --days must be integers, --days at least 1'), process.exit(1));
    const { generateTraffic, DEMO_DEVELOPERS } = await import('./mock/traffic.js');
    const { demoKey } = await import('./demo/policy.js');
    const r = await generateTraffic({ gatewayUrl: o.gatewayUrl, keys: Object.fromEntries(DEMO_DEVELOPERS.map((d) => [d.name, demoKey(d.name)])), seed, days });
    console.log(`tokenyard traffic: ${r.requests} requests in ${r.sessions} sessions sent to ${o.gatewayUrl.length} gateway(s)`);
  });
// Live tests (spec 14.1): `npm run live` reads .env with node --env-file; hidden from --help.
program
  .command('live', { hidden: true })
  .description('live-test harness: the gateway with the live policy and the tokenyard-enforced cap (npm run live)')
  .option('--port <n>', 'port to listen on (0 picks a free one)', '4000')
  .action(async (o: { port: string }) => {
    const { startLiveHarness } = await import('./live/harness.js');
    let h: Awaited<ReturnType<typeof startLiveHarness>>;
    try {
      // The trace dir and the live policy are fixed under the package root (never an option, never the cwd), so every
      // run seeds the same spend.
      h = await startLiveHarness({ env: process.env, today: new Date().toISOString().slice(0, 10), port: Number(o.port) });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    const stop = (): void => void h.close().then(() => process.exit(0));
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
const sinceOf = (v: string, now: number): number => (/^\d+[hd]$/.test(v) ? now - parseDuration(v) : Date.parse(v));
const policy = program.command('policy').description('policy files');
policy
  .command('check')
  .description('validate a policy directory: schema, then the semantic rules; exits 1 on errors')
  .argument('[dir]', 'policy directory (policy.yaml, prices.yaml, keys.yaml)', 'policy')
  .option('--experimental-subscription', 'allow the subscription passthrough items (docs/experimental-subscription.md)')
  .action(async (dir: string, o: { experimentalSubscription?: boolean }) => {
    const { loadPolicyDir } = await import('./policy-loader/load-dir.js');
    const { PolicyLoadError } = await import('./policy/load-dir.js');
    const { UnsafePathError } = await import('./fsutil/safe-path.js');
    const { validatePolicy } = await import('./policy/validate.js');
    let errors: Array<{ code: string; path: string; message: string }>;
    let warnings: Array<{ code: string; path: string; message: string }> = [];
    try {
      const r = validatePolicy(await loadPolicyDir(dir), { experimentalSubscription: o.experimentalSubscription === true });
      ({ errors, warnings } = r);
    } catch (e) {
      if (e instanceof UnsafePathError) return void (console.error(`tokenyard policy check: ${e.message}`), process.exit(1));
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
    const { cliRoot, UnsafePathError, writeFileUnder } = await import('./fsutil/safe-path.js');
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
      await writeFileUnder(cliRoot(o.out), o.out, serializeBundle(bundle));
      console.error(`wrote ${o.out}: revision ${bundle.manifest.revision}, sha256 ${bundle.manifest.sha256}`);
    } catch (e) {
      if (e instanceof UnsafePathError) return void (console.error(`tokenyard policy build: ${e.message}`), process.exit(1));
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
policy
  .command('replay')
  .description('replay a merged trace export against a base and a head policy: fidelity, cost, reroutes, blocks, cut sessions, budget hits; exits 1 when a ci.failOn gate fails')
  .option('--base-ref <git ref>', 'the base is the --head directory as committed at this git ref, read as git objects (never the working tree)')
  .option('--base-dir <dir>', 'the base is this policy directory')
  .option('--base <dir or git ref>', 'alias that takes either; refused when the value is both a directory and a git ref')
  .requiredOption('--head <dir>', 'head policy directory')
  .requiredOption('--traces <files...>', 'export file(s) written by tokenyard traces export (.ndjson or .ndjson.gz); a trace directory is refused')
  .option('--since <when>', 'duration such as 7d, or an ISO time; earlier records only seed budget windows (default: the export window)')
  .option('--tenant <tenant>', 'only this tenant')
  .option('--json <file>', 'also write the full result as JSON (docs/replay-json.md)')
  .option('--base-revision <rev>', 'revision the base was recorded under (default: the content revision serve --policy records)')
  .option('--head-revision <rev>', 'revision of the head (default: its content revision)')
  .option('--experimental-subscription', 'allow the subscription passthrough items (docs/experimental-subscription.md)')
  .action(async (o: { base?: string; baseRef?: string; baseDir?: string; head: string; traces: string[]; since?: string; tenant?: string; json?: string; baseRevision?: string; headRevision?: string; experimentalSubscription?: boolean }) => {
    const { cliRoot, writeFileUnder } = await import('./fsutil/safe-path.js');
    const { loadReplayPolicy, openReplayTraces } = await import('./policy-loader/replay-input.js');
    const { replay } = await import('./replay/engine.js');
    const { renderJson } = await import('./replay/render-json.js');
    const { renderTerminal } = await import('./replay/render-terminal.js');
    const experimentalSubscription = o.experimentalSubscription === true;
    const sinceMs = o.since === undefined ? null : sinceOf(o.since, Date.now());
    if (sinceMs !== null && Number.isNaN(sinceMs)) return void (console.error('tokenyard policy replay: --since must be a duration or an ISO time'), process.exit(1));
    const bases = [o.baseRef === undefined ? null : { source: o.baseRef, as: 'ref' as const }, o.baseDir === undefined ? null : { source: o.baseDir, as: 'dir' as const }, o.base === undefined ? null : { source: o.base, as: 'either' as const }].filter((b) => b !== null);
    const chosen = bases[0];
    if (bases.length !== 1 || chosen === undefined) return void (console.error('tokenyard policy replay: give exactly one of --base-ref <git ref> or --base-dir <dir>'), process.exit(1));
    try {
      const base = await loadReplayPolicy({ ...chosen, headDir: o.head, experimentalSubscription, ...(o.baseRevision ? { revision: o.baseRevision } : {}) });
      const head = await loadReplayPolicy({ source: o.head, as: 'dir', headDir: o.head, experimentalSubscription, ...(o.headRevision ? { revision: o.headRevision } : {}) });
      const result = await replay({ base, head, traces: await openReplayTraces(o.traces), sinceMs, tenant: o.tenant ?? null });
      if (o.json) await writeFileUnder(cliRoot(o.json), o.json, renderJson(result), { private: true });
      process.stdout.write(renderTerminal(result));
      if (result.gates.failed.length > 0) process.exitCode = 1;
    } catch (e) {
      console.error(`tokenyard policy replay: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });
const traces = program.command('traces').description('trace files written by serve --trace-dir');
traces
  .command('export')
  .description('merge every instance file in a window into one ordered NDJSON file with a manifest line first')
  .requiredOption('--trace-dir <dir>', 'trace directory (shared storage when several instances write)')
  .requiredOption('--out <file>', 'output file; a name ending in .gz is gzipped')
  .option('--since <when>', 'duration such as 7d or 12h, or an ISO time', '7d')
  .option('--until <when>', 'ISO time (default now)')
  .option('--anonymize', 'replace tenant, team, key id, repo, branch and ticket with salted pseudonyms and drop client.version')
  .option('--salt-file <path>', 'file holding a one-off salt for --anonymize (or TOKENYARD_EXPORT_SALT); default: a random salt, never stored; never the trace salt')
  .option('--salt <salt>', 'refused: a salt on the command line is visible to every local user; use TOKENYARD_EXPORT_SALT or --salt-file')
  .option('--trace-salt-file <path>', 'the gateway trace salt, when it is kept in a file rather than TOKENYARD_TRACE_SALT: the --anonymize salt must differ from it')
  .action(async (o: { traceDir: string; out: string; since: string; until?: string; anonymize?: boolean; salt?: string; saltFile?: string; traceSaltFile?: string }) => {
    // A one-off salt (B7): never the gateway's trace salt, whose holder would reverse the pseudonyms by dictionary and
    // link every export made with it. Without one, a random salt is used and forgotten.
    let salt = await secretInput('tokenyard traces export', { flag: 'salt', value: o.salt, file: o.saltFile, env: 'TOKENYARD_EXPORT_SALT' });
    const traceSalt = await secretInput('tokenyard traces export', { flag: 'trace-salt', file: o.traceSaltFile, env: 'TOKENYARD_TRACE_SALT' });
    if (o.anonymize && salt !== undefined && salt === traceSalt) {
      return void (console.error('tokenyard traces export: the --anonymize salt must differ from the trace salt (TOKENYARD_TRACE_SALT or --trace-salt-file); use a one-off salt, or none for a random one'), process.exit(1));
    }
    if (o.anonymize && salt === undefined) {
      salt = (await import('node:crypto')).randomBytes(24).toString('base64url');
      console.error('tokenyard traces export: --anonymize used a random one-off salt (not stored; pseudonyms match no other export)');
    }
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
  .option('--html <file>', 'write a self-contained HTML report (no script, no external requests) instead of the terminal table')
  .action(async (o: { traces: string; by: string; since: string; until?: string; tenant?: string; html?: string }) => {
    const dims = o.by.split(',').map((d) => d.trim()).filter(Boolean);
    const bad = dims.filter((d) => !REPORT_DIMENSIONS.includes(d as ReportDimension));
    if (bad.length > 0) return void (console.error(`tokenyard report: unknown dimension ${bad.join(', ')}`), process.exit(1));
    const now = Date.now();
    const records = await loadTraceRecords({ path: o.traces, sinceMs: sinceOf(o.since, now), untilMs: o.until ? Date.parse(o.until) : now, ...(o.tenant ? { tenant: o.tenant } : {}) });
    const report = buildReport(records, dims as ReportDimension[]);
    if (o.html) {
      const { cliRoot, UnsafePathError, writeFileUnder } = await import('./fsutil/safe-path.js');
      const { renderReportHtml } = await import('./report/render-html.js');
      try {
        await writeFileUnder(cliRoot(o.html), o.html, renderReportHtml(report), { private: true });
      } catch (e) {
        if (e instanceof UnsafePathError) return void (console.error(`tokenyard report: ${e.message}`), process.exit(1));
        throw e;
      }
      console.error(`wrote ${o.html}: ${report.totals.requests} requests`);
      return;
    }
    process.stdout.write(renderReportTerminal(report));
  });
program
  .command('action')
  .description('GitHub Action entry point: policy check, replay against the base ref, sticky PR comment, job summary (inputs come from INPUT_* variables, action.yml)')
  .action(async () => {
    const { githubClient, runAction } = await import('./action/main.js');
    process.exitCode = await runAction(process.env, githubClient(process.env));
  });
// `runs: using: node24, main: bin/tokenyard.mjs` starts the bundle without arguments: inside an Action that means `action`.
const argv = process.argv.length === 2 && process.env.GITHUB_ACTIONS === 'true' && process.env['INPUT_POLICY-DIR'] !== undefined ? [...process.argv, 'action'] : process.argv;
await program.parseAsync(argv);
