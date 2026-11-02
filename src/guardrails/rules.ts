// Secret rules (spec 6.6): prefix-anchored, ported by hand from the gitleaks catalog to JS regexes. Pure.
// gitleaks (https://github.com/gitleaks/gitleaks, config/gitleaks.toml) is MIT licensed; each rule names the gitleaks
// rule id it was ported from and how it differs.
//
// Rules run on decoded JSON string content (scan.ts). Linear time is a rule for every regex here: every quantifier is
// bounded, and a variable-length token starts only where the character before it is outside its own alphabet
// (a lookbehind), so a long run of token characters is tried from one start, not from every position in it.
// test/guardrails/redos.test.ts holds every rule to a time bound on crafted 1 MiB bodies.

export interface SecretRule {
  /** Stable id: shown in error messages and stored in traces. */
  id: string;
  /** Literal prefilter: the regex runs only when at least one keyword occurs in the scanned bytes. Empty: always runs. */
  keywords: string[];
  /** The value is capture group 1 when the regex has one, else the whole match. */
  regex: RegExp;
  /** Where the rule comes from (gitleaks rule id, or tokenyard). */
  source: string;
  licence: string;
  /** Detection by entropy alone: `warn` at most, never block (hashes and lockfile integrity strings look random too). */
  entropyOnly?: boolean;
  /** Minimum Shannon entropy in bits per character of the value. */
  minEntropy?: number;
  /** Extra check on the value (checksums for PII). */
  validate?: (value: string) => boolean;
}

const GITLEAKS = 'MIT (gitleaks)';

export const DEFAULT_RULES: readonly SecretRule[] = Object.freeze([
  {
    id: 'aws-access-key-id',
    keywords: ['AKIA', 'ASIA'],
    regex: /\b((?:AKIA|ASIA)[A-Z2-7]{16})\b/,
    source: 'gitleaks aws-access-token (AKIA and ASIA prefixes only)',
    licence: GITLEAKS,
  },
  {
    id: 'github-pat',
    keywords: ['ghp_'],
    regex: /\b(ghp_[0-9A-Za-z]{36})\b/,
    source: 'gitleaks github-pat',
    licence: GITLEAKS,
  },
  {
    id: 'github-oauth',
    keywords: ['gho_'],
    regex: /\b(gho_[0-9A-Za-z]{36})\b/,
    source: 'gitleaks github-oauth',
    licence: GITLEAKS,
  },
  {
    id: 'github-app-token',
    keywords: ['ghs_', 'ghu_'],
    regex: /\b((?:ghs|ghu)_[0-9A-Za-z]{36})\b/,
    source: 'gitleaks github-app-token',
    licence: GITLEAKS,
  },
  {
    id: 'github-fine-grained-pat',
    keywords: ['github_pat_'],
    regex: /\b(github_pat_\w{82})\b/,
    source: 'gitleaks github-fine-grained-pat',
    licence: GITLEAKS,
  },
  {
    id: 'slack-token',
    keywords: ['xoxa-', 'xoxb-', 'xoxp-', 'xoxo-', 'xoxs-', 'xoxr-'],
    regex: /(?<![0-9A-Za-z_-])(xox[abposr]-\d{6,13}-[0-9A-Za-z-]{10,256})/,
    source: 'gitleaks slack-bot-token, slack-user-token, slack-legacy-token (one rule over xox[abposr]-)',
    licence: GITLEAKS,
  },
  {
    id: 'stripe-live-key',
    keywords: ['sk_live_', 'rk_live_'],
    regex: /(?<![0-9A-Za-z_])((?:sk|rk)_live_[0-9A-Za-z]{10,99})(?![0-9A-Za-z_])/,
    source: 'gitleaks stripe-access-token (live keys only)',
    licence: GITLEAKS,
  },
  {
    id: 'private-key',
    keywords: ['-----BEGIN'],
    // The key body may hold any character except the string separator and a run of five dashes, so a match never spans
    // from one block's BEGIN to a later block's END or across two JSON strings (a key split across text blocks is
    // matched in the joined view of the message instead).
    regex: /(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:[^\0-]|-(?!----)){64,65536}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)/,
    source: 'gitleaks private-key (key body capped at 64 KiB and never across a BEGIN or END line)',
    licence: GITLEAKS,
  },
  {
    id: 'jwt',
    keywords: ['eyJ'],
    regex: /(?<![0-9A-Za-z_-])(eyJ[0-9A-Za-z_-]{15,4096}\.eyJ[0-9A-Za-z_-]{15,16384}\.[0-9A-Za-z_-]{10,4096})/,
    source: 'gitleaks jwt (signed tokens with a JSON header and payload only)',
    licence: GITLEAKS,
  },
  {
    id: 'anthropic-api-key',
    keywords: ['sk-ant-'],
    // api03, admin01, oat01 (OAuth) and later numbered kinds; the repo's `sk-ant-test-CANARY` fake has no number.
    regex: /(?<![0-9A-Za-z_-])(sk-ant-[a-z]{2,8}\d{2}-[0-9A-Za-z_-]{80,512})/,
    source: 'gitleaks anthropic-api-key and anthropic-admin-api-key (any numbered key kind, length not pinned)',
    licence: GITLEAKS,
  },
  {
    id: 'openai-api-key',
    keywords: ['sk-proj-', 'sk-svcacct-', 'sk-admin-'],
    regex: /(?<![0-9A-Za-z_-])(sk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{40,512})/,
    source: 'gitleaks openai-api-key (project, service account and admin keys, without the T3BlbkFJ marker)',
    licence: GITLEAKS,
  },
  {
    id: 'google-api-key',
    keywords: ['AIza'],
    regex: /(?<![0-9A-Za-z_-])(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/,
    source: 'gitleaks gcp-api-key',
    licence: GITLEAKS,
  },
  {
    id: 'tokenyard-key',
    keywords: ['ty_live_'],
    regex: /\b(ty_live_[0-9A-Za-z]{43})\b/,
    source: 'tokenyard (src/edge/keys.ts: ty_live_ plus 43 base62 characters)',
    licence: 'MIT (tokenyard)',
  },
  {
    id: 'generic-secret-assignment',
    keywords: ['secret', 'Secret', 'SECRET', 'token', 'Token', 'TOKEN', 'passw', 'Passw', 'PASSW', 'api_key', 'apiKey', 'API_KEY', 'apikey', 'APIKEY', 'api-key'],
    // A name ending in secret, token, password or api key, `=` or `:`, then a long random-looking value. Entropy only:
    // never blocks.
    regex: /(?:secret|token|passw(?:or)?d|api[_-]?key)[0-9A-Za-z_-]{0,20}["']?[ \t]{0,4}[:=][ \t]{0,4}["']?([0-9A-Za-z+/_.=-]{32,128})/i,
    source: 'gitleaks generic-api-key (simplified; entropy threshold 4.0)',
    licence: GITLEAKS,
    entropyOnly: true,
    minEntropy: 4.0,
  },
]);
