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
await program.parseAsync(process.argv);
