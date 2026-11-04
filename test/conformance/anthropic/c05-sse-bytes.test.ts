import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, send, startRawUpstream, startStack } from '../../helpers/conformance.js';

let up: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  await up?.close();
  up = stack = undefined;
});

test('C5 SSE output bytes equal upstream bytes, ping and unknown event types included [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
    'event: ping\ndata: {"type": "ping"}\n\n',
    'event: future_event_2099\ndata: {"type":"future_event_2099","payload":{"zz":1,"aa":[1,2]}}\n\n',
    ': a comment line\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"zażółć \u0041"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const all = Buffer.from(frames.join(''), 'utf8');
  up = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Cut at arbitrary byte offsets (inside frames and inside the multi-byte character) with pauses between.
    const cuts = [7, 40, 133, 190, 311, all.length];
    let from = 0;
    let i = 0;
    const next = (): void => {
      const to = Math.min(cuts[i++] ?? all.length, all.length);
      res.write(all.subarray(from, to));
      from = to;
      if (from >= all.length) res.end();
      else setTimeout(next, 5);
    };
    next();
  });
  stack = await startStack({ upstream: up.url });
  const res = await send(stack.gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ stream: true }) });
  expect(res.status).toBe(200);
  expect(res.body.equals(all)).toBe(true);
});
