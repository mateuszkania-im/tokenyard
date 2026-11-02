import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TraceWriter } from '../../src/ledger/writer.js';
import { loadPrices } from '../helpers/prices.js';
import { authHeaders, send, startStack } from '../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
let dir: string | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function allTraceText(root: string): Promise<string> {
  const out: string[] = [];
  for (const t of await readdir(root)) {
    for (const d of await readdir(join(root, t))) {
      for (const f of await readdir(join(root, t, d))) out.push(await readFile(join(root, t, d, f), 'utf8'));
    }
  }
  return out.join('\n');
}

test('records contain no prompt text: a body with a canary string never appears in any trace file', async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-gw-trace-'));
  const writer = new TraceWriter({ dir, instanceId: 'gw01', queueMax: 100, clock: Date.now });
  stack = await startStack({ gw: { traces: writer, traceSalt: 'salt', prices: loadPrices() } });
  const body = JSON.stringify({
    model: 'claude-opus-5-5',
    max_tokens: 64,
    system: 'CANARY-system-prompt',
    messages: [
      { role: 'user', content: 'CANARY-user-prompt, read /home/alice/CANARY-secret-file.ts' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/alice/CANARY-path.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'CANARY-tool-output' }] },
    ],
  });
  const res = await send(stack.gw.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-claude-code-session-id': 'CANARY-session' }, body });
  expect(res.status).toBe(200);
  const root = dir;
  await expect
    .poll(async () => {
      await writer.flushed();
      return (await allTraceText(root).catch(() => '')).includes('"kind":"request"');
    })
    .toBe(true);
  await writer.close();
  const text = await allTraceText(dir);
  expect(text).toContain('"kind":"request"');
  expect(text).not.toContain('CANARY');
  expect(text).not.toContain('/home/alice');
  expect(text).not.toContain('ty_live');
});
