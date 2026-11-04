// Preloaded (NODE_OPTIONS --import) into every node child a test starts (test/setup/process-guard.ts). A listener
// bound to every interface (0.0.0.0 or ::) is recorded in the guard directory; the global teardown fails the run on
// any record. Loopback binds and unix sockets are not recorded. No output, no handlers, no change to the child.
import { appendFileSync } from 'node:fs';
import { Server } from 'node:net';
import { join } from 'node:path';

const dir = process.env.TOKENYARD_TEST_GUARD_DIR;
if (dir) {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function guardedListen(...args) {
    this.once('listening', () => {
      const a = this.address();
      if (a && typeof a === 'object' && (a.address === '0.0.0.0' || a.address === '::')) {
        appendFileSync(join(dir, `wildcard-${process.pid}.txt`), `${a.address}:${a.port} ${process.argv.slice(1).join(' ')}\n`);
      }
    });
    return listen.apply(this, args);
  };
}
