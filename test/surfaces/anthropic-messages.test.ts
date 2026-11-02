import { expect, test } from 'vitest';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';

const body = Buffer.from(
  JSON.stringify({
    model: 'claude-test',
    max_tokens: 2048,
    stream: true,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    system: [{ type: 'text', text: 'You are helpful' }],
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ],
    messages: [
      { role: 'user', content: 'read the file "]}" please' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'zażółć \\" ]' }] },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ],
      },
    ],
  }),
);

test('extractAnthropicFeatures: server tools with max_uses, block types, image block sets expandsServerSide', () => {
  const f = extractAnthropicFeatures(body);
  expect(f.parseError).toBe(false);
  expect(f.model).toBe('claude-test');
  expect(f.stream).toBe(true);
  expect(f.maxOutputTokens).toBe(2048);
  expect(f.toolCount).toBe(3);
  expect(f.thinking).toBe(true);
  expect(f.serverTools).toEqual([
    { type: 'web_search_20250305', maxUses: 3 },
    { type: 'web_fetch_20250910', maxUses: null },
  ]);
  expect([...f.blockTypes].sort()).toEqual(['image', 'text', 'tool_result', 'tool_use']);
  expect(f.expandsServerSide).toBe(true);
  expect(f.bodyBytes).toBe(body.length);
  expect(f.prefixHash).toMatch(/^[0-9a-f]{64}$/);
});

test('lastTurn is the byte range of the last message in the original body', () => {
  const f = extractAnthropicFeatures(body);
  expect(f.lastTurn).not.toBeNull();
  const slice = body.subarray(f.lastTurn?.start, f.lastTurn?.end).toString('utf8');
  const parsed = JSON.parse(body.toString('utf8')) as { messages: unknown[] };
  expect(JSON.parse(slice)).toEqual(parsed.messages[2]);
});

test('lastTurn handles whitespace and a duplicate messages key (last one wins, like JSON.parse)', () => {
  const b = Buffer.from('{"messages":[{"role":"user","content":"old"}], "x":"\\"messages\\"", "messages" : [ {"role":"user","content":"a"} ,\n {"role":"user","content":"b"}  ] }');
  const f = extractAnthropicFeatures(b);
  expect(b.subarray(f.lastTurn?.start, f.lastTurn?.end).toString()).toBe('{"role":"user","content":"b"}');
  expect(extractAnthropicFeatures(Buffer.from('{"messages":[]}')).lastTurn).toBeNull();
});

test('lastTurn is the newest user-role message, not an assistant prefill after it (spec 5.3 step 5)', () => {
  const b = Buffer.from(JSON.stringify({
    model: 'm',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'newest' }] },
      { role: 'assistant', content: 'prefill' },
    ],
  }));
  const f = extractAnthropicFeatures(b);
  expect(f.lastTurn).toMatchObject({ index: 2 });
  expect(JSON.parse(b.subarray(f.lastTurn?.start, f.lastTurn?.end).toString())).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'newest' }] });
  expect(f.messages?.map((r) => JSON.parse(b.subarray(r.start, r.end).toString()).content)).toEqual(['first', 'reply', [{ type: 'tool_result', tool_use_id: 't1', content: 'newest' }], 'prefill']);
  // No user message at all: there is no last turn.
  expect(extractAnthropicFeatures(Buffer.from('{"messages":[{"role":"assistant","content":"x"}]}')).lastTurn).toBeNull();
});

test('prefixHash changes with system or tools and not with messages', () => {
  const base = { model: 'm', max_tokens: 1, system: 's', tools: [{ name: 'a' }], messages: [{ role: 'user', content: 'x' }] };
  const h = (o: object): string | null => extractAnthropicFeatures(Buffer.from(JSON.stringify(o))).prefixHash;
  expect(h(base)).toBe(h({ ...base, messages: [{ role: 'user', content: 'y' }] }));
  expect(h(base)).not.toBe(h({ ...base, system: 't' }));
  expect(h(base)).not.toBe(h({ ...base, tools: [{ name: 'b' }] }));
  expect(h({ model: 'm', messages: [] })).toBeNull();
});

test('defaults and parse errors', () => {
  const plain = extractAnthropicFeatures(Buffer.from('{"model":"m","messages":[{"role":"user","content":"hi"}]}'));
  expect(plain).toMatchObject({ stream: false, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], expandsServerSide: false });
  expect(extractAnthropicFeatures(Buffer.from('{"thinking":{"type":"disabled"}}')).thinking).toBe(false);
  const bad = extractAnthropicFeatures(Buffer.from('{"model":'));
  expect(bad).toMatchObject({ parseError: true, model: null, bodyBytes: 9, lastTurn: null, prefixHash: null });
  expect(extractAnthropicFeatures(Buffer.from('[1,2]')).parseError).toBe(true);
  const doc = extractAnthropicFeatures(Buffer.from('{"messages":[{"role":"user","content":[{"type":"document","source":{}}]}]}'));
  expect(doc.expandsServerSide).toBe(true);
});

test('fastMode is set by speed "fast" (any value other than standard fails safe to fast)', () => {
  const f = (o: object) => extractAnthropicFeatures(Buffer.from(JSON.stringify({ model: 'm', messages: [], ...o }))).fastMode;
  expect(f({})).toBe(false);
  expect(f({ speed: 'standard' })).toBe(false);
  expect(f({ speed: null })).toBe(false);
  expect(f({ speed: 'fast' })).toBe(true);
  expect(f({ speed: 'turbo' })).toBe(true);
  expect(extractAnthropicFeatures(Buffer.from('{')).fastMode).toBe(false);
});

test('expandsServerSide: fields and tools that make the provider add input, or that are unknown, fail safe', () => {
  const x = (o: object) =>
    extractAnthropicFeatures(Buffer.from(JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], ...o }))).expandsServerSide;
  // Documented Messages API fields that add no provider-side input stay on the bytes bound.
  expect(
    x({
      stream: true, system: [{ type: 'text', text: 's' }], metadata: { user_id: 'u' }, stop_sequences: ['x'], temperature: 1, top_p: 1, top_k: 1,
      thinking: { type: 'adaptive' }, tool_choice: { type: 'auto' }, tools: [{ name: 'Read', input_schema: {} }, { type: 'custom', name: 'B', input_schema: {} }],
      cache_control: { type: 'ephemeral' }, inference_geo: 'us', service_tier: 'auto', speed: 'fast', diagnostics: { previous_message_id: null },
      output_config: { effort: 'high' },
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }, { type: 'clear_thinking_20251015' }] },
    }),
  ).toBe(false);
  expect(x({ mcp_servers: [{ type: 'url', url: 'https://example.com', name: 'a' }] })).toBe(true);
  expect(x({ container: 'container_1' })).toBe(true);
  expect(x({ some_future_field: 1 })).toBe(true);
  expect(x({ output_config: { format: { type: 'json_schema', schema: {} } } })).toBe(true);
  expect(x({ context_management: { edits: [{ type: 'compact_20260112' }] } })).toBe(true);
  expect(x({ context_management: 'x' })).toBe(true);
  // Anthropic-defined client tools add documented hidden tokens (toolsets about 4,500 to 6,600), more than the overhead.
  expect(x({ tools: [{ type: 'bash_20250124', name: 'bash' }] })).toBe(true);
  // Server-side tools are counted in serverTools instead, MCP and unknown tool types included.
  const st = (o: object) => extractAnthropicFeatures(Buffer.from(JSON.stringify({ model: 'm', messages: [], ...o }))).serverTools;
  expect(st({ tools: [{ type: 'mcp_toolset', mcp_server_name: 'a', max_uses: 4 }] })).toEqual([{ type: 'mcp_toolset', maxUses: 4 }]);
  expect(st({ tools: [{ type: 'future_tool_20270101', name: 'f' }] })).toEqual([{ type: 'future_tool_20270101', maxUses: null }]);
  expect(st({ mcp_servers: [{ type: 'url', url: 'https://example.com', name: 'a' }] })).toEqual([{ type: 'mcp_servers', maxUses: null }]);
  expect(st({ tools: [{ type: 'bash_20250124', name: 'bash' }, { name: 'Read', input_schema: {} }] })).toEqual([]);
  expect(x({ tools: [{ type: 'computer_toolset_20260801', name: 'c' }] })).toBe(true);
  // A system block that is not text is an unknown block type.
  const sys = extractAnthropicFeatures(Buffer.from(JSON.stringify({ model: 'm', system: [{ type: 'document', source: {} }], messages: [] })));
  expect(sys.blockTypes).toContain('document');
});

test('ambiguous keys: a duplicate top-level messages key or a duplicate role or content in a message is flagged', () => {
  const f = (s: string) => extractAnthropicFeatures(Buffer.from(s)).ambiguousKeys;
  expect(f('{"messages":[{"role":"user","content":"a"}],"messages":[{"role":"user","content":"b"}]}')).toBe(true);
  expect(f('{"messages":[{"role":"user","content":"a","role":"assistant"}]}')).toBe(true);
  expect(f('{"messages":[{"role":"user","content":"a","c\\u006fntent":"b"}]}')).toBe(true);
  expect(f('{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}')).toBeUndefined();
});
