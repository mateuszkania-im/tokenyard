// The demo's policies: examples/policy (base) and examples/policy-head (the demo PR), embedded so `tokenyard demo`
// runs from the single bundled file. The revisions are those `serve --policy examples/policy` would record (content
// hash of the example files), so the committed demo traces replay against the example directories with fidelity 100%.
// Only what the process needs changes after the revision is taken: provider URLs point at the mocks, keys are the demo
// developers' keys.
import { hashKey } from '../edge/auth.js';
import { DEMO_DEVELOPERS } from '../mock/traffic.js';
import { buildBundle } from '../policy/bundle.js';
import { compilePolicy } from '../policy/compile.js';
import { parsePolicyFiles, type PolicySource } from '../policy/load-dir.js';
import type { CompiledPolicy, KeyRecord } from '../policy/types.js';
import { EXAMPLE_BASE, EXAMPLE_HEAD } from './example-files.js';

/** Environment variable the demo policy reads the (fake) provider key from. */
export const DEMO_CREDENTIAL_ENV = 'TOKENYARD_DEMO_UPSTREAM_KEY';
export const DEMO_TENANT = 'acme';

/** Plaintext key of a demo developer. Public on purpose: it only opens the demo's in-process gateway. */
export const demoKey = (name: string): string => `ty_live_demo_${name}`;

function compileDemo(dir: string, files: Record<string, string>, upstream: string, openaiUpstream: string): CompiledPolicy {
  const src: PolicySource = parsePolicyFiles(dir, files);
  const revision = buildBundle(src, { createdAt: '1970-01-01T00:00:00.000Z' }).manifest.revision;
  for (const p of Object.values(src.policy.providers)) {
    p.baseUrl = p.format === 'openai' ? openaiUpstream : upstream;
    p.credential = { env: DEMO_CREDENTIAL_ENV };
  }
  src.keys = DEMO_DEVELOPERS.map(
    (d): KeyRecord => ({ hash: hashKey(demoKey(d.name)), keyId: `key_${hashKey(demoKey(d.name)).slice(0, 8)}`, tenant: DEMO_TENANT, team: d.team, name: d.name, kind: 'developer', billing: 'api' }),
  );
  return compilePolicy(src, revision, { experimentalSubscription: false });
}

/** Anthropic-format providers point at `upstream`, OpenAI-format ones at `openaiUpstream` (default `upstream`). */
export function demoPolicies(upstream: string, openaiUpstream = upstream): { base: CompiledPolicy; head: CompiledPolicy } {
  return { base: compileDemo('examples/policy', EXAMPLE_BASE, upstream, openaiUpstream), head: compileDemo('examples/policy-head', EXAMPLE_HEAD, upstream, openaiUpstream) };
}
