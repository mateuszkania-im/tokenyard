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
