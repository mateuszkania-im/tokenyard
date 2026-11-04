import { mulberry32 } from './scenarios.js';

const WORDS = ['alpha', 'build', 'cache', 'diff', 'edit', 'file', 'grep', 'hook', 'index', 'jest', 'kind', 'lint', 'merge', 'node', 'patch', 'query'];

function text(rng: () => number, words: number): string {
  return Array.from({ length: words }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(' ');
}

const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'Write'].map((name) => ({
  name,
  description: `${name} tool for the coding agent. `.repeat(20),
  input_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
}));

/**
 * Claude Code shaped request bodies, one per turn: block-form system with cache_control, tools,
 * growing messages with signed thinking blocks and tool use, and the cache marker on the last user block.
 */
export function buildAgentSession(turns: number, seed: number): Buffer[] {
  const rng = mulberry32(seed);
  const systemText = text(rng, 600);
  type Msg = { role: string; content: unknown[] };
  const history: Msg[] = [];
  const bodies: Buffer[] = [];
  for (let i = 0; i < turns; i++) {
    const userBlock = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: t, ...extra });
    const content: unknown[] =
      i === 0
        ? [userBlock(`Task ${i}: ${text(rng, 40)}`)]
        : [{ type: 'tool_result', tool_use_id: `toolu_${i - 1}`, content: text(rng, 20 + Math.floor(rng() * 200)) }];
    history.push({ role: 'user', content });
    const messages = history.map((m, idx) => {
      if (idx !== history.length - 1) return m;
      const blocks = [...m.content] as Record<string, unknown>[];
      const last = blocks.length - 1;
      blocks[last] = { ...(blocks[last] as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
      return { ...m, content: blocks };
    });
    bodies.push(
      Buffer.from(
        JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 32000,
          stream: true,
          thinking: { type: 'enabled', budget_tokens: 8000 },
          system: [
            { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
            { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
          ],
          tools: TOOLS,
          messages,
        }),
      ),
    );
    history.push({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: text(rng, 30), signature: `sig_${seed}_${i}_${Math.floor(rng() * 1e9).toString(36)}` },
        { type: 'text', text: text(rng, 15) },
        { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { input: text(rng, 4) } },
      ],
    });
  }
  return bodies;
}
