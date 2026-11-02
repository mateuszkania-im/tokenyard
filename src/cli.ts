import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

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
  .option('--experimental-subscription', 'experimental: accept keys with billing subscription and forward the user OAuth token (docs/experimental-subscription.md)')
  .action(async (o: { port: string; host: string; basePath?: string; devUpstream?: string; experimentalSubscription?: boolean }) => {
    if (!o.devUpstream) {
      console.error('tokenyard serve: policy loading is not available yet; use --dev-upstream <url>');
      process.exit(1);
    }
    const { randomUUID } = await import('node:crypto');
    const { createGateway, DEFAULT_BODY_CAP_BYTES } = await import('./edge/server.js');
    const { devPolicy, DEV_KEY, DEV_UPSTREAM_KEY_ENV } = await import('./edge/dev-policy.js');
    const policy = devPolicy({ upstream: o.devUpstream, keys: [DEV_KEY], credential: { env: DEV_UPSTREAM_KEY_ENV }, models: [] });
    const gw = createGateway({
      policy: () => policy,
      store: null,
      traces: null,
      clock: Date.now,
      newId: randomUUID,
      basePath: o.basePath ?? null,
      bodyCapBytes: DEFAULT_BODY_CAP_BYTES,
      experimentalSubscription: o.experimentalSubscription === true,
    });
    console.log(await gw.listen(Number(o.port), o.host));
    const stop = (): void => void gw.close().then(() => process.exit(0));
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
await program.parseAsync(process.argv);
