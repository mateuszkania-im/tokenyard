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
  .action(async (o: { port: string; host: string; basePath?: string; devUpstream?: string }) => {
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
    });
    console.log(await gw.listen(Number(o.port), o.host));
    const stop = (): void => void gw.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
await program.parseAsync(process.argv);
