import { afterEach, expect, test } from 'vitest';
import { inputTokenBound } from '../../src/limits/estimator.js';
import { lookupModel } from '../../src/pricing/prices.js';
import { extractResponsesFeatures } from '../../src/surfaces/openai-responses.js';
import { codexHeaders, respBody, send, startOpenAIStack } from '../helpers/conformance.js';
import { loadPrices } from '../helpers/prices.js';

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const mini = (): NonNullable<ReturnType<typeof lookupModel>>['price'] => {
  const m = lookupModel(loadPrices(), 'gpt-5.4-mini');
  if (!m) throw new Error('gpt-5.4-mini is not priced');
  return m.price;
};

test('Codex-shaped body: model, stream, no max_output_tokens, client tools, reasoning, bytes bound', () => {
  const body = respBody();
  const x = extractResponsesFeatures(body);
  expect(x).toMatchObject({ model: 'gpt-5.4-mini', stream: true, maxOutputTokens: null, toolCount: 1, thinking: true, serverTools: [], parseError: false, expandsServerSide: false, fastMode: false });
  expect(x.blockTypes).toEqual(['input_text']);
  expect(inputTokenBound(x, mini())).toEqual({ tokens: body.length + 4096, kind: 'bytes' });
});

test('encrypted reasoning items, images and stored state fall back to the context window bound', () => {
  const ctx = { tokens: 400000, kind: 'context-window' };
  const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' };
  expect(inputTokenBound(extractResponsesFeatures(respBody({ input: [user('a'), reasoning] })), mini())).toEqual(ctx);
  const image = { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] };
  expect(inputTokenBound(extractResponsesFeatures(respBody({ input: [image] })), mini())).toEqual(ctx);
  for (const extra of [{ previous_response_id: 'resp_1' }, { conversation: 'conv_1' }, { prompt: { id: 'pmpt_1' } }, { x_new_field: 1 }, { text: { format: { type: 'json_schema' } } }]) {
    expect(extractResponsesFeatures(respBody(extra)).expandsServerSide, JSON.stringify(extra)).toBe(true);
  }
  expect(extractResponsesFeatures(respBody({ text: { verbosity: 'low', format: { type: 'text' } } })).expandsServerSide).toBe(false);
});

test('built-in tools are server tools with max_tool_calls as their bound; client tools are not', () => {
  const tools = [{ type: 'function', name: 'f' }, { type: 'custom', name: 'apply_patch' }, { type: 'local_shell' }, { type: 'web_search' }, { type: 'mcp', server_label: 's' }, { type: 'code_interpreter' }, { type: 'file_search' }, { type: 'something_new' }];
  expect(extractResponsesFeatures(respBody({ tools })).serverTools).toEqual(['web_search', 'mcp', 'code_interpreter', 'file_search', 'something_new'].map((type) => ({ type, maxUses: null })));
  expect(extractResponsesFeatures(respBody({ tools: [{ type: 'web_search' }], max_tool_calls: 3 })).serverTools).toEqual([{ type: 'web_search', maxUses: 3 }]);
});

test('Codex 0.166.0: a namespace of client function tools is a client tool; one holding a built-in tool is not; client_metadata is plain', () => {
  const ns = { type: 'namespace', name: 'multi_agent_v1', description: 'sub-agents', tools: [{ type: 'function', name: 'spawn_agent', parameters: {} }, { type: 'function', name: 'close_agent', parameters: {} }] };
  const x = extractResponsesFeatures(respBody({ tools: [ns], client_metadata: { session_id: 's', turn_id: 't' } }));
  expect(x.serverTools).toEqual([]);
  expect(x.expandsServerSide).toBe(false);
  const nested = { ...ns, tools: [{ type: 'function', name: 'f' }, { type: 'web_search' }, { type: 'namespace', name: 'deep', tools: [{ type: 'mcp' }] }] };
  expect(extractResponsesFeatures(respBody({ tools: [nested] })).serverTools).toEqual([{ type: 'web_search', maxUses: null }, { type: 'mcp', maxUses: null }]);
  expect(extractResponsesFeatures(respBody({ tools: [{ type: 'namespace', name: 'bad', tools: 'x' }] })).serverTools).toEqual([{ type: 'namespace', maxUses: null }]);
});

test('unparseable and non-object bodies are parse errors', () => {
  expect(extractResponsesFeatures(Buffer.from('{"model":')).parseError).toBe(true);
  expect(extractResponsesFeatures(Buffer.from('[1]')).parseError).toBe(true);
});

test('last turn: the trailing user message and tool outputs; else the newest user message; a string input is the turn', () => {
  const items = [user('first'), { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }, { type: 'function_call_output', call_id: 'c1', output: 'tool says' }];
  const body = respBody({ input: items });
  const x = extractResponsesFeatures(body);
  expect(x.lastTurn?.index).toBe(2);
  expect(body.toString('utf8', x.lastTurn?.start, x.lastTurn?.end)).toBe(JSON.stringify(items[2]));

  const withUser = [...items, user('next prompt')];
  const y = extractResponsesFeatures(respBody({ input: withUser }));
  expect(y.lastTurn?.index).toBe(2);
  expect(y.messages).toHaveLength(4);

  const endsWithAssistant = [user('only'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }];
  expect(extractResponsesFeatures(respBody({ input: endsWithAssistant })).lastTurn?.index).toBe(0);

  const s = respBody({ input: 'plain prompt' });
  const z = extractResponsesFeatures(s);
  expect(s.toString('utf8', z.lastTurn?.start, z.lastTurn?.end)).toBe('"plain prompt"');
});

test('duplicate keys are ambiguous: top-level input, or an item with two outputs', () => {
  expect(extractResponsesFeatures(Buffer.from('{"model":"gpt-5.4-mini","input":"a","input":"b"}')).ambiguousKeys).toBe(true);
  expect(extractResponsesFeatures(Buffer.from('{"model":"gpt-5.4-mini","input":[{"type":"function_call_output","call_id":"c","output":"x","output":"y"}]}')).ambiguousKeys).toBe(true);
  expect(extractResponsesFeatures(respBody()).ambiguousKeys).toBeUndefined();
});

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const AWS = 'AKIAIOSFODNN7EXAMPLE';

test('guardrails on Responses: escaped secrets in a tool output, duplicate keys and unparseable bodies are all blocked', async () => {
  stack = await startOpenAIStack();
  const escaped = AWS.replace('A', '\\u0041');
  const call = '{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}';
  const bodies = [
    // Decoded content: the key written with a JSON escape in the newest tool output.
    `{"model":"gpt-5.4-mini","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]},${call},{"type":"function_call_output","call_id":"c1","output":"key ${escaped}"}]}`,
    // Duplicate output keys: JSON.parse keeps the last, a provider may read the first.
    `{"model":"gpt-5.4-mini","stream":true,"input":[{"type":"function_call_output","call_id":"c1","output":"key ${AWS}","output":"clean"}]}`,
    // Not JSON: the raw bytes are scanned.
    `{"model":"gpt-5.4-mini","input":"key ${AWS}"`,
  ];
  for (const body of bodies) {
    const res = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body });
    expect(res.status, body).toBe(400);
    expect(JSON.parse(res.body.toString()).error.code).toBe('secret_detected');
  }
  expect(stack.mock.received).toHaveLength(0);
});

test('service_tier: absent, null and default are standard; any other value is carried as the tier', () => {
  for (const v of [undefined, null, 'default']) expect(extractResponsesFeatures(respBody(v === undefined ? {} : { service_tier: v })).serviceTier).toBeUndefined();
  for (const v of ['auto', 'priority', 'flex', 'scale', 'x']) expect(extractResponsesFeatures(respBody({ service_tier: v })).serviceTier).toBe(v);
  expect(extractResponsesFeatures(respBody({ service_tier: 7 })).serviceTier).toBe('7');
  expect(extractResponsesFeatures(respBody({ service_tier: 'priority' })).fastMode).toBe(false);
});

test('fix 1: a shell tool with a hosted environment or a container is a server tool; local or no environment is client', () => {
  const st = (tools: unknown[]) => extractResponsesFeatures(respBody({ tools })).serverTools;
  expect(st([{ type: 'shell', environment: { type: 'container_auto' } }])).toEqual([{ type: 'shell', maxUses: null }]);
  expect(st([{ type: 'shell', environment: { type: 'container_reference', container_id: 'c' } }])).toEqual([{ type: 'shell', maxUses: null }]);
  expect(st([{ type: 'shell', environment: 'weird' }])).toEqual([{ type: 'shell', maxUses: null }]);
  expect(st([{ type: 'local_shell', container: { type: 'auto' } }])).toEqual([{ type: 'local_shell', maxUses: null }]);
  expect(st([{ type: 'apply_patch', environment: { type: 'container_auto' } }])).toEqual([{ type: 'apply_patch', maxUses: null }]);
  expect(st([{ type: 'shell' }, { type: 'shell', environment: { type: 'local' } }, { type: 'apply_patch' }, { type: 'local_shell' }])).toEqual([]);
  // Nested in a namespace, the same rule.
  expect(st([{ type: 'namespace', name: 'n', tools: [{ type: 'shell', environment: { type: 'container_auto' } }] }])).toEqual([{ type: 'shell', maxUses: null }]);
});

test('fix 2: OpenAI-defined client tools (local_shell, shell, apply_patch) force the context-window bound; function and custom do not', () => {
  for (const t of [{ type: 'local_shell' }, { type: 'shell' }, { type: 'shell', environment: { type: 'local' } }, { type: 'apply_patch' }]) {
    const x = extractResponsesFeatures(respBody({ tools: [t] }));
    expect(x.expandsServerSide, JSON.stringify(t)).toBe(true);
    expect(inputTokenBound(x, mini()).kind).toBe('context-window');
  }
  expect(extractResponsesFeatures(respBody({ tools: [{ type: 'function', name: 'f' }, { type: 'custom', name: 'c' }] })).expandsServerSide).toBe(false);
  expect(extractResponsesFeatures(respBody({ tools: [{ type: 'namespace', name: 'n', tools: [{ type: 'apply_patch' }] }] })).expandsServerSide).toBe(true);
});
