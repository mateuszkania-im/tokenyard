import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

const program = new Command();
program.name('tokenyard').description(pkg.description).version(pkg.version);
await program.parseAsync(process.argv);
