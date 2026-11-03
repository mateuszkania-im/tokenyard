// V4 fuzz: `traces export --anonymize` (src/ledger/anonymize.ts). Generated secrets, file paths, emails, hostnames and
// tokens never survive into the anonymized record, in any form the record keeps (the whole JSON line is searched);
// pseudonyms stay stable within one salt.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { anonymizeRecord, saltedPseudonyms } from '../../src/ledger/anonymize.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';
import { baseRecord } from '../helpers/trace.js';

const label = fc.stringMatching(/^[a-z][a-z0-9]{2,9}$/);
const email = fc.tuple(label, label, fc.constantFrom('com', 'pl', 'io')).map(([u, d, t]) => `${u}@${d}.${t}`);
const path = fc.array(label, { minLength: 2, maxLength: 5 }).map((xs) => `/home/${xs.join('/')}.ts`);
const winPath = fc.array(label, { minLength: 1, maxLength: 3 }).map((xs) => `C:\\Users\\${xs.join('\\')}`);
const hostname = fc.array(label, { minLength: 2, maxLength: 4 }).map((xs) => `${xs.join('.')}.internal`);
const token = fc.tuple(fc.constantFrom('sk-ant-api03-', 'ghp_', 'AKIA', 'xoxb-', 'Bearer '), fc.stringMatching(/^[A-Za-z0-9]{16,32}$/)).map(([p, s]) => p + s);
const phrase = fc.tuple(label, label).map(([a, b]) => `Customer ${a} ${b}`);
/** Something nobody wants in an export; every one holds a character no pseudonym (lowercase hex, `kind-`) has. */
const sensitive = fc.oneof(email, path, winPath, hostname, token, phrase);
/**
 * Model ids and upstream error codes keep values shaped like ids (`claude-opus-5-5`, `overloaded_error`) by design (B1):
 * the gateway writes a client's unpriced model name as `model-<hex>` at ingest, and error codes come from the upstream.
 * So these fields get only values outside that shape (docs/testing.md).
 */
const notIdShaped = fc.oneof(email, path, winPath, token, phrase).filter((s) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s));

const SALT_A = 'export-salt-a';

/** A record with a generated value in every field a client, key file or deployment chooses. */
const record = fc
  .record({
    tenant: sensitive, team: fc.option(sensitive, { nil: null }), keyId: sensitive, instance: sensitive, version: sensitive,
    session: sensitive, agent: sensitive, parentAgent: sensitive, promptId: sensitive, requestClass: sensitive, agentType: sensitive,
    repo: sensitive, branch: sensitive, ticket: sensitive, feature: sensitive,
    model: notIdShaped, upstreamModel: notIdShaped, toolType: sensitive, serviceTier: sensitive, prefixHash: sensitive, valueHmac: sensitive,
    errorClass: notIdShaped, midStreamError: notIdShaped, headerName: sensitive, headerValue: fc.constantFrom('42', '2026-11-03T10:00:00Z'),
    extra: sensitive,
  })
  .map((g) => {
    const b = baseRecord();
    const r = {
      ...b,
      instance: g.instance,
      seq: 1,
      tenant: g.tenant,
      team: g.team,
      keyId: g.keyId,
      client: { agent: 'claude-code' as const, version: g.version },
      attribution: { session: g.session, agent: g.agent, parentAgent: g.parentAgent, promptId: g.promptId, requestClass: g.requestClass, agentType: g.agentType, repo: g.repo, branch: g.branch, ticket: g.ticket, feature: g.feature, sanitized: true as const, [`x-${g.extra}`]: g.extra },
      features: { ...b.features, model: g.model, serverTools: [{ type: g.toolType, maxUses: 1 }], prefixHash: g.prefixHash, serviceTier: g.serviceTier, [g.extra]: g.extra },
      guardrail: { hits: [{ rule: 'aws-access-key-id', action: 'block' as const, valueHmac: g.valueHmac, where: 'history' as const }] },
      outcome: { ...b.outcome, upstreamModel: g.upstreamModel, errorClass: g.errorClass, midStreamError: g.midStreamError, serviceTier: g.serviceTier, rateLimitHeaders: { [g.headerName]: g.headerValue, 'anthropic-ratelimit-unified-status': g.headerValue }, [g.extra]: g.extra },
      [g.extra]: g.extra,
    } as unknown as TraceRecord;
    const secrets = Object.entries(g).filter(([k, v]) => k !== 'headerValue' && v !== null).map(([, v]) => v as string);
    return { r, secrets };
  });

test('fuzz: no generated secret, path, email, hostname or token survives anonymizeRecord', () => {
  const p = saltedPseudonyms(SALT_A);
  fc.assert(
    fc.property(record, ({ r, secrets }) => {
      const out = JSON.stringify(anonymizeRecord(r, p));
      for (const s of secrets) expect(out.includes(s), `survived: ${s}`).toBe(false);
      // Also no long piece of one (a value cut short would still leak most of it).
      for (const s of secrets) for (let i = 0; i + 12 <= s.length; i += 4) expect(out.includes(s.slice(i, i + 12)), `piece of ${s}`).toBe(false);
    }),
    fuzz(0xa401, 1_000),
  );
}, fuzzTimeout(10_000));

/** Known server tool types (any date suffix) are kept in exports by design; every other word must not survive. */
const KNOWN_TOOLS = new Set(['web_search', 'web_fetch', 'code_execution', 'tool_search_tool_regex', 'tool_search_tool_bm25', 'advisor', 'mcp_toolset', 'mcp_servers', 'memory', 'bash', 'text_editor', 'str_replace_editor', 'str_replace_based_edit_tool', 'computer', 'browser_toolset', 'web_search_preview', 'web_search_preview_2025_03_11', 'file_search', 'code_interpreter', 'mcp', 'image_generation', 'computer_use_preview', 'computer_use', 'local_shell', 'shell', 'apply_patch', '(invalid)']);
const toolWord = fc.oneof(
  fc.stringMatching(/^[a-z]{1,12}(?:_[a-z]{1,12}){0,4}(?:_\d{8})?$/),
  fc.stringMatching(/^[a-z0-9_]{1,64}$/),
  fc.string({ maxLength: 80 }),
).filter((t) => !KNOWN_TOOLS.has(t) && !KNOWN_TOOLS.has(t.replace(/_\d{8}$/, '')));

test('fuzz: a server tool type no provider documents (letters-only words included) is exported only as a pseudonym or `(invalid)`', () => {
  const p = saltedPseudonyms(SALT_A);
  fc.assert(
    fc.property(toolWord, (t) => {
      const b = baseRecord();
      const out = anonymizeRecord({ ...b, instance: 'i', seq: 1, features: { ...b.features, serverTools: [{ type: t, maxUses: 1 }] } }, p).features.serverTools[0]?.type as string;
      expect(out === '(invalid)' || /^toolType-[0-9a-f]{8}$/.test(out), out).toBe(true);
      expect(out).not.toBe(t);
    }),
    fuzz(0xa403, 1_000),
  );
}, fuzzTimeout(10_000));

test('fuzz: within one salt the same value gets the same pseudonym (joins survive), other salts give other values', () => {
  const a = saltedPseudonyms(SALT_A);
  const b = saltedPseudonyms('export-salt-b');
  fc.assert(
    fc.property(record, ({ r }) => {
      const x = anonymizeRecord(r, a);
      const y = anonymizeRecord(structuredClone(r), a);
      expect(y).toEqual(x);
      // The subagent join: an agent and the parent agent field of its child share one kind.
      const child = anonymizeRecord({ ...r, attribution: { ...r.attribution, parentAgent: r.attribution.agent } }, a);
      expect(child.attribution.parentAgent).toBe(x.attribution.agent);
      expect(anonymizeRecord(r, b).tenant).not.toBe(x.tenant);
    }),
    fuzz(0xa402, 300),
  );
}, fuzzTimeout(10_000));
