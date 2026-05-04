# Claim Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fact-checking and hallucination detection as a separate, parallel-running claim extractor alongside the existing validator (currently v17). Add an on-demand verification endpoint that uses Brave Search + Haiku to judge whether a flagged claim is supported, contradicted, or inconclusive.

**Architecture:**
- `/api/analyze-response` fires two Haiku calls in parallel via `Promise.allSettled`: the existing validator (gap-spotting, returns `validations`) and a new claim extractor (returns `verifiable_claims`). Failures degrade gracefully — one prompt failing returns the other's results.
- New `/api/verify-claim` endpoint: auth + ownership check → quota check (unified counter) → Brave Search → Haiku verdict (`confirmed | contradicted | inconclusive | error`) → persist to `claim_verifications` table.

**Tech Stack:** TypeScript, Vercel serverless, Anthropic SDK (Haiku 4.5), Supabase Postgres, Brave Search REST API, vitest.

**Open spec resolutions (locked in by user):**
- Migration number is `0006` (`0005` already used by validations schema).
- Validator version recorded via `SYSTEM_PROMPT_VERSION` constant (currently v17). Spec's "v13" is stale.
- Top-level `skip` semantics unchanged: only `true` when the trigger gate fires. `validations[]` and `verifiable_claims[]` may be independently empty.
- Brave key in `.env.local` only — never committed. User to rotate post-build.
- Local-only verification (`vercel dev` + curl). Deploy is a separate, user-triggered step.

---

## File structure

**Create:**
- `prompts/claim-extractor-prompt.ts` — system prompt + version constant for the extractor.
- `prompts/verifier-prompt.ts` — system prompt + version constant for the verifier.
- `lib/claim-extractor.ts` — Haiku call wrapper, parser, anchor validation. Mirrors `lib/claude.ts` shape.
- `lib/brave-search.ts` — Brave Search REST client. Returns `{title, snippet, url}[]`.
- `lib/verifier.ts` — Haiku call wrapper for verification, parser.
- `api/verify-claim.ts` — endpoint handler.
- `supabase/migrations/0006_verifiable_claims.sql` — schema migration.
- `tests/claim-extractor.test.ts`, `tests/brave-search.test.ts`, `tests/verifier.test.ts` — unit tests for parsers/clients.

**Modify:**
- `types/index.ts` — add `VerifiableClaim`, `ClaimType`, `Verdict`, `ClaimExtractorResult`, `VerifyRequestBody`, `VerifyResponse`, extend `SkipReason` with `claim_extractor_error` if needed (decided: not needed; partial success).
- `api/analyze-response.ts` — parallel calls, merged response, persist `verifiable_claims` + `claim_extractor_*` columns.
- `test-curl.sh` — add cases 9 and 10.
- `README.md` — new "Claim verification" section.
- `.env.example` — add `BRAVE_API_KEY=` placeholder with comment.
- `tests/setup.ts` — add `BRAVE_API_KEY` shim for unit tests.

---

## Task 1: Env + types prep

**Files:**
- Modify: `.env.example`
- Modify: `tests/setup.ts`
- Modify: `types/index.ts`

- [ ] **Step 1: Add Brave key placeholder to `.env.example`**

Append at end:

```
# Brave Search API — used by /api/verify-claim to verify factual claims.
# Free tier: 2000 queries/month. Sign up at https://api.search.brave.com.
BRAVE_API_KEY=
```

- [ ] **Step 2: Add Brave shim to `tests/setup.ts`**

Append:

```ts
process.env.BRAVE_API_KEY ||= "test-brave";
```

- [ ] **Step 3: Add new types to `types/index.ts`**

Append at end (before final closing brace if any — file ends with `ClaudeUsage`):

```ts
// Claim extractor (parallel to validator). Output of prompts/claim-extractor-prompt.ts.
export type ClaimType =
  | "statistic"
  | "citation"
  | "person_or_role"
  | "date"
  | "product_or_pricing"
  | "current_state"
  | "quote"
  | "technical_fact";

export type Risk = "high" | "medium" | "low";

export interface VerifiableClaim {
  claim: string;
  anchored_to: string;
  claim_type: ClaimType;
  why_verify: string;
  risk: Risk;
}

export interface ClaimExtractorResult {
  skip: boolean;
  verifiable_claims: VerifiableClaim[];
}

// Verify endpoint.
export type Verdict = "confirmed" | "contradicted" | "inconclusive" | "error";

export interface VerifyRequestBody {
  analysis_id: string;
  claim_index: number;
}

export type VerifyResponse =
  | {
      verdict: Verdict;
      evidence_summary: string;
      source_urls: string[];
      verification_id: string;
    }
  | { error: "unauthorized" }
  | { error: "not_found" }
  | { error: "quota_exceeded"; limit: number; used: number }
  | { error: "internal" }
  | { error: "bad_request"; message: string };

// Brave Search client.
export interface BraveSearchResult {
  title: string;
  snippet: string;
  url: string;
}

// Augmented analyze response includes verifiable_claims + prompt_versions.
// Old `AnalyzeResponse` union stays backward compatible — fields are additive.
export interface PromptVersions {
  validator: string;
  claim_extractor: string;
}
```

Also extend the `AnalyzeResponse` union: change the success arm to include the new fields (additive, never required by old extension code):

Find:
```ts
| { skip: false; validations: Validation[]; analysis_id: string }
```

Replace with:
```ts
| {
      skip: false;
      validations: Validation[];
      verifiable_claims: VerifiableClaim[];
      analysis_id: string;
      prompt_versions: PromptVersions;
    }
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean (existing files use the augmented response only after Task 5; until then unchanged code still compiles because the extra fields are added, not removed).

- [ ] **Step 5: Commit**

```bash
git add .env.example tests/setup.ts types/index.ts
git commit -m "Scaffold types and env for claim verification"
```

---

## Task 2: Migration 0006 — verifiable_claims columns + claim_verifications table

**Files:**
- Create: `supabase/migrations/0006_verifiable_claims.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Crith AI V2 — claim verification schema (parallel claim extractor + verify endpoint)
-- Adds columns to response_analyses for the parallel claim extractor's output and
-- introduces claim_verifications for on-demand /api/verify-claim results.

-- ============================================================================
-- response_analyses additions
-- ============================================================================
alter table public.response_analyses
  add column if not exists verifiable_claims jsonb not null default '[]'::jsonb,
  add column if not exists claim_extractor_version text,
  add column if not exists claim_extractor_tokens_in int,
  add column if not exists claim_extractor_tokens_out int;

comment on column public.response_analyses.verifiable_claims is
  'Output from claim-extractor-prompt. Parallel to validations. v1+';

-- ============================================================================
-- claim_verifications — one row per /api/verify-claim invocation
-- ============================================================================
create table if not exists public.claim_verifications (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references public.response_analyses(id) on delete cascade,
  claim_index       int  not null,
  user_id           uuid not null references auth.users(id) on delete cascade,
  verdict           text not null check (verdict in ('confirmed', 'contradicted', 'inconclusive', 'error')),
  evidence_summary  text,
  source_urls       jsonb not null default '[]'::jsonb,
  search_tokens_used int,
  haiku_tokens_in   int,
  haiku_tokens_out  int,
  latency_ms        int,
  created_at        timestamptz not null default now()
);

create index if not exists claim_verifications_user_id_created_at_idx
  on public.claim_verifications (user_id, created_at desc);

create index if not exists claim_verifications_analysis_id_idx
  on public.claim_verifications (analysis_id);

create index if not exists claim_verifications_verdict_idx
  on public.claim_verifications (verdict);

alter table public.claim_verifications enable row level security;

create policy "users see own verifications"
  on public.claim_verifications for select
  using (user_id = auth.uid());

-- No INSERT policy — writes happen via service role from /api/verify-claim.
```

- [ ] **Step 2: Apply locally via Supabase CLI (if available) or paste into Studio**

If Supabase CLI is installed and linked:
```bash
supabase db push
```

Otherwise: open Supabase Studio → SQL Editor → paste the contents of `0006_verifiable_claims.sql` → Run. Verify no errors.

- [ ] **Step 3: Verify the schema landed**

In Studio SQL Editor:
```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'response_analyses'
  and column_name in ('verifiable_claims', 'claim_extractor_version',
                      'claim_extractor_tokens_in', 'claim_extractor_tokens_out');

select tablename from pg_tables where tablename = 'claim_verifications';
```

Expected: 4 rows from the first query, 1 row from the second.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0006_verifiable_claims.sql
git commit -m "Add 0006: verifiable_claims columns + claim_verifications table"
```

---

## Task 3: Claim extractor system prompt

**Files:**
- Create: `prompts/claim-extractor-prompt.ts`

- [ ] **Step 1: Create the prompt file**

```ts
export const CLAIM_EXTRACTOR_VERSION = "v1";

export const CLAIM_EXTRACTOR_PROMPT = `You identify verifiable factual claims in an AI assistant's response that the user might want to fact-check before relying on them.

Scope: this prompt is for verifiable factual claims only. Reasoning gaps, missing perspectives, unjustified assumptions, and tone issues are handled by separate prompts — do not duplicate that work here. Stay on facts.

# What counts as a verifiable claim

A verifiable claim is a specific factual statement where "is this true?" or "is this still true?" can be settled by an external source like a search engine or a primary document.

Types of verifiable claims to flag:

1. SPECIFIC STATISTICS — Numbers presented as facts (market sizes, percentages, rankings, prices).
2. CITATIONS AND STUDIES — References to studies, papers, books, or experts. Especially "according to a 2023 study..." with no named source.
3. NAMED PEOPLE AND ROLES — "The CEO of X is Y", "Founded by Z in year W". These go stale.
4. DATES AND TIMELINES — Specific years, months, or sequences of events.
5. PRODUCT FEATURES AND PRICING — "X costs $Y", "X integrates with Y", "X launched in Z".
6. CURRENT STATE CLAIMS — "The latest version is X", "X is the leading Y", "X recently announced Y".
7. QUOTES — "As X said: '...'". Quotes are easy for AIs to fabricate.
8. SPECIFIC TECHNICAL FACTS — API limits, library versions, configuration values, algorithmic complexities stated as fact.

# What NOT to flag

- Reasoning, recommendations, opinions, or subjective judgments
- Vague generalizations ("most companies", "many users") — too vague to verify
- The AI's own framing of the user's situation
- Hidden assumptions, missing perspectives, or other gaps — those belong to the validator prompt
- Common knowledge a reasonable user would not need to verify
- Claims the user supplied themselves in the prompt — those aren't AI claims

# Why this matters

AI training data has a knowledge cutoff. AI also fabricates citations, statistics, and quotes that sound plausible. The user reading the response can't tell which specific facts to verify. Your job is to surface them.

You are NOT verifying the claims. You are flagging them as worth verifying. The user (or a separate verification endpoint) does the actual lookup.

# Output rules

Return at most 3 verifiable claims per response. Quality over quantity.

Each claim MUST:

- Have a \`claim\` field that restates the fact in a clean, searchable form. Not a copy of the response — a sentence the user could paste into a search engine.
- Have an \`anchored_to\` field that is a VERBATIM 30-80 char substring of the AI's response. Same discipline as the validator. Must satisfy \`response.includes(anchored_to)\` exactly.
- Have a \`claim_type\` from this enum: "statistic" | "citation" | "person_or_role" | "date" | "product_or_pricing" | "current_state" | "quote" | "technical_fact"
- Have a \`why_verify\` field — one short sentence explaining why this specific claim is worth checking. Examples: "Specific market size with no source given." "AI knowledge has a cutoff; this person may have changed roles."
- Have a \`risk\` field — "high" | "medium" | "low" — based on how badly the user would be misled if the claim turned out to be false.

# Skip rules

If the response contains no specific verifiable claims (pure reasoning, advice, opinion, code), return \`skip: true\` with empty array.

If the response is short (under 100 words), return \`skip: true\` unless a specific high-risk claim is present.

# Output format

Return ONLY valid JSON, no preamble:

{
  "skip": false,
  "verifiable_claims": [
    {
      "claim": "string — clean, searchable form of the claim",
      "anchored_to": "string — verbatim 30-80 char substring of the AI's response",
      "claim_type": "statistic" | "citation" | "person_or_role" | "date" | "product_or_pricing" | "current_state" | "quote" | "technical_fact",
      "why_verify": "string — one sentence",
      "risk": "high" | "medium" | "low"
    }
  ]
}

If skip is true, verifiable_claims must be an empty array.

# Worked examples

EXAMPLE 1
Response excerpt: "According to a 2023 McKinsey study, 73% of enterprise AI projects fail in the first year due to poor data infrastructure."

Output:
{
  "claim": "McKinsey 2023 study reporting 73% of enterprise AI projects fail in the first year due to poor data infrastructure",
  "anchored_to": "73% of enterprise AI projects fail in the first year",
  "claim_type": "statistic",
  "why_verify": "Specific statistic attributed to a named study; AIs frequently fabricate plausible-sounding research citations.",
  "risk": "high"
}

EXAMPLE 2
Response excerpt: "Sam Altman is the CEO of OpenAI."

Output:
{
  "claim": "Sam Altman is the CEO of OpenAI",
  "anchored_to": "Sam Altman is the CEO of OpenAI",
  "claim_type": "person_or_role",
  "why_verify": "Leadership roles change; AI knowledge has a cutoff.",
  "risk": "medium"
}

EXAMPLE 3 (do NOT flag)
Response excerpt: "Most startups fail because they don't find product-market fit fast enough."

Do not flag — vague generalization, not a specific verifiable claim.

EXAMPLE 4 (do NOT flag)
Response excerpt: "I'd recommend starting with Postgres for your use case."

Do not flag — opinion/recommendation, belongs to the validator prompt if anything.`;

export function buildClaimExtractorUserMessage(userPrompt: string, aiResponse: string): string {
  return `USER'S PROMPT:
"""
${userPrompt}
"""

AI'S RESPONSE:
"""
${aiResponse}
"""

Extract verifiable claims and return JSON.`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add prompts/claim-extractor-prompt.ts
git commit -m "Add claim-extractor system prompt (v1)"
```

---

## Task 4: Claim extractor lib (Haiku call + parser)

**Files:**
- Create: `lib/claim-extractor.ts`
- Create: `tests/claim-extractor.test.ts`

- [ ] **Step 1: Write failing parser test**

Create `tests/claim-extractor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseClaimExtractorResponse } from "../lib/claim-extractor.js";

const RESPONSE = "According to a 2023 McKinsey study, 73% of enterprise AI projects fail in the first year due to poor data infrastructure. Sam Altman is the CEO of OpenAI.";

describe("parseClaimExtractorResponse", () => {
  it("parses a well-formed response", () => {
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [
        {
          claim: "McKinsey 2023 study reporting 73% AI project failure",
          anchored_to: "73% of enterprise AI projects fail in the first year",
          claim_type: "statistic",
          why_verify: "Specific statistic; AIs frequently fabricate citations.",
          risk: "high"
        }
      ]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result).not.toBeNull();
    expect(result!.skip).toBe(false);
    expect(result!.verifiable_claims).toHaveLength(1);
    expect(result!.verifiable_claims[0].claim_type).toBe("statistic");
  });

  it("drops claims whose anchored_to is not a substring of the response", () => {
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [
        {
          claim: "fake claim",
          anchored_to: "this string does not appear in the response at all",
          claim_type: "statistic",
          why_verify: "test",
          risk: "low"
        }
      ]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.verifiable_claims).toHaveLength(0);
  });

  it("returns skip with empty array", () => {
    const json = JSON.stringify({ skip: true, verifiable_claims: [] });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.skip).toBe(true);
    expect(result!.verifiable_claims).toHaveLength(0);
  });

  it("rejects invalid claim_type", () => {
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [
        {
          claim: "x",
          anchored_to: "Sam Altman is the CEO of OpenAI",
          claim_type: "not_a_real_type",
          why_verify: "x",
          risk: "low"
        }
      ]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    // Soft-drop: keeps the array structure but excludes invalid claim
    expect(result!.verifiable_claims).toHaveLength(0);
  });

  it("returns null on totally malformed JSON", () => {
    expect(parseClaimExtractorResponse("not json", RESPONSE)).toBeNull();
    expect(parseClaimExtractorResponse(JSON.stringify({}), RESPONSE)).toBeNull();
  });

  it("caps at 3 claims even if model returns more", () => {
    const claim = {
      claim: "x",
      anchored_to: "Sam Altman is the CEO of OpenAI",
      claim_type: "person_or_role",
      why_verify: "x",
      risk: "low"
    };
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [claim, claim, claim, claim, claim]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.verifiable_claims).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test -- claim-extractor.test.ts`
Expected: FAIL — `parseClaimExtractorResponse` not exported (module doesn't exist).

- [ ] **Step 3: Implement `lib/claim-extractor.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  CLAIM_EXTRACTOR_PROMPT,
  buildClaimExtractorUserMessage
} from "../prompts/claim-extractor-prompt.js";
import type {
  ClaimExtractorResult,
  ClaudeUsage,
  VerifiableClaim
} from "../types/index.js";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing required env var: ANTHROPIC_API_KEY");
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.2;
const MAX_RESPONSE_CHARS = 12000;
const TRUNCATION_MARKER = "\n\n[...truncated...]";
const MAX_CLAIMS = 3;

const VALID_CLAIM_TYPES = new Set([
  "statistic",
  "citation",
  "person_or_role",
  "date",
  "product_or_pricing",
  "current_state",
  "quote",
  "technical_fact"
]);
const VALID_RISKS = new Set(["high", "medium", "low"]);

function truncate(s: string): string {
  return s.length <= MAX_RESPONSE_CHARS ? s : s.slice(0, MAX_RESPONSE_CHARS) + TRUNCATION_MARKER;
}

function extractFirstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseClaimExtractorResponse(
  rawText: string,
  aiResponse: string
): ClaimExtractorResult | null {
  const jsonText = extractFirstJsonBlock(rawText);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.skip !== "boolean") return null;
  if (!Array.isArray(obj.verifiable_claims)) return null;

  if (obj.skip && obj.verifiable_claims.length > 0) {
    return { skip: true, verifiable_claims: [] };
  }

  const claims: VerifiableClaim[] = [];
  for (const raw of obj.verifiable_claims) {
    if (claims.length >= MAX_CLAIMS) break;
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (
      typeof c.claim !== "string" ||
      typeof c.anchored_to !== "string" ||
      typeof c.claim_type !== "string" ||
      typeof c.why_verify !== "string" ||
      typeof c.risk !== "string"
    ) continue;
    if (!VALID_CLAIM_TYPES.has(c.claim_type)) continue;
    if (!VALID_RISKS.has(c.risk)) continue;
    if (c.claim.length === 0 || c.claim.length > 400) continue;
    if (c.why_verify.length === 0 || c.why_verify.length > 200) continue;
    if (!aiResponse.includes(c.anchored_to)) {
      console.warn("[claim-extractor] dropping claim: anchor not verbatim", {
        claim_type: c.claim_type,
        anchored_to_preview: c.anchored_to.slice(0, 120)
      });
      continue;
    }
    claims.push({
      claim: c.claim,
      anchored_to: c.anchored_to,
      claim_type: c.claim_type as VerifiableClaim["claim_type"],
      why_verify: c.why_verify,
      risk: c.risk as VerifiableClaim["risk"]
    });
  }

  return { skip: obj.skip, verifiable_claims: claims };
}

interface CallSuccess {
  ok: true;
  result: ClaimExtractorResult;
  usage: ClaudeUsage;
}
interface CallFailure {
  ok: false;
  reason: "parse_error";
  usage: ClaudeUsage;
}
export type ClaimExtractorCallResult = CallSuccess | CallFailure;

export async function extractClaims(
  userPrompt: string,
  aiResponse: string
): Promise<ClaimExtractorCallResult> {
  const truncated = truncate(aiResponse);
  const userMessage = buildClaimExtractorUserMessage(userPrompt, truncated);

  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: CLAIM_EXTRACTOR_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: userMessage }]
  });

  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }

  const usage: ClaudeUsage = {
    tokens_in: message.usage.input_tokens,
    tokens_out: message.usage.output_tokens,
    cached_tokens: message.usage.cache_read_input_tokens ?? 0
  };

  const parsed = parseClaimExtractorResponse(text, truncated);
  if (!parsed) return { ok: false, reason: "parse_error", usage };
  return { ok: true, result: parsed, usage };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- claim-extractor.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/claim-extractor.ts tests/claim-extractor.test.ts
git commit -m "Add claim extractor lib with parser tests"
```

---

## Task 5: Refactor /api/analyze-response for parallel calls

**Files:**
- Modify: `api/analyze-response.ts`
- Modify: `lib/claude.ts` (no behavioral change — only re-exporting `truncateResponse` for the extractor path; already exported)

- [ ] **Step 1: Update insert helper to take new optional fields**

Modify `InsertRowInput` interface (around line 49):

```ts
interface InsertRowInput {
  user_id: string;
  body: AnalyzeRequestBody;
  skipped: boolean;
  skip_reason: SkipReason | null;
  validations: Validation[];
  verifiable_claims: VerifiableClaim[];
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  latency_ms: number;
  history_turn_count: number;
  history_chars: number;
  claim_extractor_version: string | null;
  claim_extractor_tokens_in: number | null;
  claim_extractor_tokens_out: number | null;
}
```

Update `insertAnalysisRow` to write the new columns:

```ts
async function insertAnalysisRow(input: InsertRowInput): Promise<string | null> {
  const { data, error } = await supabaseService
    .from("response_analyses")
    .insert({
      user_id: input.user_id,
      platform: input.body.platform,
      conversation_id: input.body.conversation_id,
      message_id: input.body.message_id,
      prompt_length: input.body.prompt.length,
      response_length: input.body.response.length,
      skipped: input.skipped,
      skip_reason: input.skip_reason,
      provocation_count: input.validations.length,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      cached_tokens: input.cached_tokens,
      latency_ms: input.latency_ms,
      prompt_version: SYSTEM_PROMPT_VERSION,
      validations: input.validations,
      verifiable_claims: input.verifiable_claims,
      claim_extractor_version: input.claim_extractor_version,
      claim_extractor_tokens_in: input.claim_extractor_tokens_in,
      claim_extractor_tokens_out: input.claim_extractor_tokens_out,
      original_prompt: input.body.prompt,
      original_response: truncateResponse(input.body.response),
      conversation_history_turn_count: input.history_turn_count,
      conversation_history_chars: input.history_chars
    })
    .select("id")
    .single();

  if (error) {
    console.error("[analyze-response] insert failed", error);
    return null;
  }
  return (data?.id as string) ?? null;
}
```

- [ ] **Step 2: Update imports at top of file**

Add to imports:

```ts
import { extractClaims } from "../lib/claim-extractor.js";
import { CLAIM_EXTRACTOR_VERSION } from "../prompts/claim-extractor-prompt.js";
import type { VerifiableClaim, PromptVersions } from "../types/index.js";
```

- [ ] **Step 3: Replace the single Claude call with parallel calls**

Find the block starting `// Claude call.` around line 179. Replace from that comment through the end of the success branch (the existing `analyzeResponse` call + the result.ok handling + the final res.status(200).json) with:

```ts
    // Parallel Haiku calls: validator (gap-spotting) + claim extractor (fact-checking).
    // Promise.allSettled so one failure doesn't kill the other. Quota was already
    // incremented above; both calls share that single quota slot.
    const start = Date.now();
    const [validatorSettled, extractorSettled] = await Promise.allSettled([
      analyzeResponse(body.prompt, body.response, cleanedHistory),
      extractClaims(body.prompt, body.response)
    ]);
    const latency_ms = Date.now() - start;

    const validatorOk = validatorSettled.status === "fulfilled" && validatorSettled.value.ok;
    const extractorOk = extractorSettled.status === "fulfilled" && extractorSettled.value.ok;

    if (validatorSettled.status === "rejected") {
      console.error("[analyze-response] validator rejected", validatorSettled.reason);
    } else if (!validatorSettled.value.ok) {
      console.warn("[analyze-response] validator parse_error");
    }

    if (extractorSettled.status === "rejected") {
      console.error("[analyze-response] extractor rejected", extractorSettled.reason);
    } else if (!extractorSettled.value.ok) {
      console.warn("[analyze-response] extractor parse_error");
    }

    // If BOTH failed, treat as full failure.
    if (!validatorOk && !extractorOk) {
      const validatorUsage =
        validatorSettled.status === "fulfilled" ? validatorSettled.value.usage : null;
      const extractorUsage =
        extractorSettled.status === "fulfilled" ? extractorSettled.value.usage : null;
      await insertAnalysisRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: validatorSettled.status === "rejected" ? "claude_error" : "parse_error",
        validations: [],
        verifiable_claims: [],
        tokens_in: validatorUsage?.tokens_in ?? 0,
        tokens_out: validatorUsage?.tokens_out ?? 0,
        cached_tokens: validatorUsage?.cached_tokens ?? 0,
        latency_ms,
        history_turn_count: history.turn_count,
        history_chars: history.char_count,
        claim_extractor_version: CLAIM_EXTRACTOR_VERSION,
        claim_extractor_tokens_in: extractorUsage?.tokens_in ?? null,
        claim_extractor_tokens_out: extractorUsage?.tokens_out ?? null
      });
      res.status(500).json({ error: "internal" });
      return;
    }

    // Pull out usable results (may be empty arrays if either side failed).
    const validatorResult =
      validatorOk && validatorSettled.status === "fulfilled" && validatorSettled.value.ok
        ? validatorSettled.value
        : null;
    const extractorResult =
      extractorOk && extractorSettled.status === "fulfilled" && extractorSettled.value.ok
        ? extractorSettled.value
        : null;

    const validations: Validation[] =
      validatorResult && !validatorResult.result.skip ? validatorResult.result.validations : [];
    const verifiable_claims: VerifiableClaim[] =
      extractorResult && !extractorResult.result.skip
        ? extractorResult.result.verifiable_claims
        : [];

    const validatorSkipped = validatorResult ? validatorResult.result.skip : true;
    const skipped = validatorSkipped && verifiable_claims.length === 0;

    const validatorUsageOk = validatorResult?.usage;
    const extractorUsageOk = extractorResult?.usage;

    const analysisId = await insertAnalysisRow({
      user_id: user.user_id,
      body,
      skipped,
      skip_reason: skipped ? "trivial" : null,
      validations,
      verifiable_claims,
      tokens_in: validatorUsageOk?.tokens_in ?? 0,
      tokens_out: validatorUsageOk?.tokens_out ?? 0,
      cached_tokens: validatorUsageOk?.cached_tokens ?? 0,
      latency_ms,
      history_turn_count: history.turn_count,
      history_chars: history.char_count,
      claim_extractor_version: CLAIM_EXTRACTOR_VERSION,
      claim_extractor_tokens_in: extractorUsageOk?.tokens_in ?? null,
      claim_extractor_tokens_out: extractorUsageOk?.tokens_out ?? null
    });

    if (!analysisId) {
      res.status(500).json({ error: "internal" });
      return;
    }

    const prompt_versions: PromptVersions = {
      validator: SYSTEM_PROMPT_VERSION,
      claim_extractor: CLAIM_EXTRACTOR_VERSION
    };

    if (skipped) {
      res.status(200).json({ skip: true, reason: "trivial", analysis_id: analysisId });
      return;
    }

    res.status(200).json({
      skip: false,
      validations,
      verifiable_claims,
      analysis_id: analysisId,
      prompt_versions
    });
```

Also update each existing `insertAnalysisRow` call earlier in the file (gate-skip path, quota-exceeded path) to pass the three new fields as `null`/`[]`:

For the gate-skip path:
```ts
verifiable_claims: [],
claim_extractor_version: null,
claim_extractor_tokens_in: null,
claim_extractor_tokens_out: null
```

For the quota-exceeded path: same additions.

Delete the old single-call try/catch block (the previous `result = await analyzeResponse(...)` plus its handling) — it's replaced by the Promise.allSettled block above.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Run all unit tests**

Run: `npm test`
Expected: all existing tests still pass; new claim-extractor tests pass.

- [ ] **Step 6: Smoke test locally**

Start `vercel dev` in another shell. Then with TEST_TOKEN exported, run case 1 manually:

```bash
bash test-curl.sh 2>&1 | head -80
```

Expected: case 1 returns a JSON response that includes both `validations` and `verifiable_claims` arrays, plus `prompt_versions: { validator: "v17", claim_extractor: "v1" }`.

- [ ] **Step 7: Commit**

```bash
git add api/analyze-response.ts
git commit -m "Run validator + claim extractor in parallel"
```

---

## Task 6: Brave Search client

**Files:**
- Create: `lib/brave-search.ts`
- Create: `tests/brave-search.test.ts`

- [ ] **Step 1: Write failing parser test**

Create `tests/brave-search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseBraveResponse } from "../lib/brave-search.js";

describe("parseBraveResponse", () => {
  it("extracts up to 5 web results", () => {
    const payload = {
      web: {
        results: [
          { title: "A", description: "snippet a", url: "https://a.com" },
          { title: "B", description: "snippet b", url: "https://b.com" },
          { title: "C", description: "snippet c", url: "https://c.com" },
          { title: "D", description: "snippet d", url: "https://d.com" },
          { title: "E", description: "snippet e", url: "https://e.com" },
          { title: "F", description: "snippet f", url: "https://f.com" }
        ]
      }
    };
    const out = parseBraveResponse(payload);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ title: "A", snippet: "snippet a", url: "https://a.com" });
  });

  it("handles missing description gracefully", () => {
    const payload = {
      web: { results: [{ title: "A", url: "https://a.com" }] }
    };
    const out = parseBraveResponse(payload);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("");
  });

  it("returns empty when no results", () => {
    expect(parseBraveResponse({})).toEqual([]);
    expect(parseBraveResponse({ web: { results: [] } })).toEqual([]);
    expect(parseBraveResponse(null)).toEqual([]);
  });

  it("filters out entries missing title or url", () => {
    const payload = {
      web: {
        results: [
          { description: "no title", url: "https://x.com" },
          { title: "no url", description: "x" },
          { title: "good", url: "https://good.com", description: "yes" }
        ]
      }
    };
    const out = parseBraveResponse(payload);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://good.com");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test -- brave-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/brave-search.ts`**

```ts
import type { BraveSearchResult } from "../types/index.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 8000;

export function parseBraveResponse(raw: unknown): BraveSearchResult[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { web?: { results?: unknown[] } };
  const results = r.web?.results;
  if (!Array.isArray(results)) return [];
  const out: BraveSearchResult[] = [];
  for (const item of results) {
    if (out.length >= MAX_RESULTS) break;
    if (!item || typeof item !== "object") continue;
    const it = item as { title?: unknown; description?: unknown; url?: unknown };
    if (typeof it.title !== "string" || typeof it.url !== "string") continue;
    out.push({
      title: it.title,
      snippet: typeof it.description === "string" ? it.description : "",
      url: it.url
    });
  }
  return out;
}

export interface BraveSearchSuccess {
  ok: true;
  results: BraveSearchResult[];
}
export interface BraveSearchError {
  ok: false;
  reason: "no_api_key" | "http_error" | "timeout" | "parse_error";
  status?: number;
}
export type BraveSearchOutcome = BraveSearchSuccess | BraveSearchError;

export async function searchClaim(query: string): Promise<BraveSearchOutcome> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(MAX_RESULTS));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "http_error" };
  }
  clearTimeout(timer);

  if (!response.ok) {
    console.error("[brave-search] non-2xx", { status: response.status, query });
    return { ok: false, reason: "http_error", status: response.status };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "parse_error" };
  }

  return { ok: true, results: parseBraveResponse(payload) };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- brave-search.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Sanity-check the live API one time**

```bash
source .env.local && curl -sS -G "https://api.search.brave.com/res/v1/web/search" \
  --data-urlencode "q=Sam Altman OpenAI CEO" \
  --data-urlencode "count=3" \
  -H "Accept: application/json" \
  -H "X-Subscription-Token: $BRAVE_API_KEY" | head -100
```

Expected: JSON response with `web.results[]`. If 401/403, the key is bad — stop and ask user.

- [ ] **Step 6: Commit**

```bash
git add lib/brave-search.ts tests/brave-search.test.ts
git commit -m "Add Brave Search client with parser tests"
```

---

## Task 7: Verifier system prompt

**Files:**
- Create: `prompts/verifier-prompt.ts`

- [ ] **Step 1: Create the prompt file**

```ts
export const VERIFIER_PROMPT_VERSION = "v1";

export const VERIFIER_PROMPT = `You evaluate whether a specific factual claim is supported, contradicted, or unverifiable based on web search results.

You receive:
- ORIGINAL CLAIM: a specific factual statement extracted from an AI response
- SEARCH RESULTS: titles, snippets, and URLs from a search engine query for that claim

Your job: judge whether the search results support, contradict, or fail to verify the claim.

# Verdict categories

CONFIRMED: Multiple credible sources directly support the claim. The specific facts (numbers, names, dates, citations) match across sources.

CONTRADICTED: Multiple credible sources directly contradict the claim. The AI's claim is wrong or outdated. Be specific about what the actual fact is.

INCONCLUSIVE: Search results don't directly address the claim, are mixed/conflicting, or come from low-credibility sources. Don't force a verdict you can't defend.

ERROR: Use only if search results are empty or unusable.

# Rules

- Cite sources by URL when stating evidence.
- If the AI's claim is "Sam Altman is the CEO of OpenAI" and search confirms — verdict CONFIRMED, evidence cites the source URLs.
- If the AI cited a specific study ("2023 McKinsey study showing 73%...") and search results don't surface that study — verdict CONTRADICTED with evidence "no such study found in search results; AI may have fabricated the citation."
- If the search results are about a similar but not identical topic — verdict INCONCLUSIVE.
- Be conservative. INCONCLUSIVE is always a valid answer when evidence is thin. False CONFIRMED or false CONTRADICTED is worse than honest INCONCLUSIVE.

# Output format

Return ONLY valid JSON:

{
  "verdict": "confirmed" | "contradicted" | "inconclusive" | "error",
  "evidence_summary": "string — 2-3 sentences explaining the verdict, citing what the search results showed",
  "source_urls": ["string", "string"]
}`;

export function buildVerifierUserMessage(
  claim: string,
  searchResults: ReadonlyArray<{ title: string; snippet: string; url: string }>
): string {
  if (searchResults.length === 0) {
    return `ORIGINAL CLAIM:
"""
${claim}
"""

SEARCH RESULTS: (none)

Return JSON.`;
  }
  const formatted = searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.snippet}\n    ${r.url}`)
    .join("\n\n");
  return `ORIGINAL CLAIM:
"""
${claim}
"""

SEARCH RESULTS:
${formatted}

Return JSON.`;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add prompts/verifier-prompt.ts
git commit -m "Add verifier system prompt (v1)"
```

---

## Task 8: Verifier lib (Haiku call + parser)

**Files:**
- Create: `lib/verifier.ts`
- Create: `tests/verifier.test.ts`

- [ ] **Step 1: Write failing parser test**

Create `tests/verifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseVerifierResponse } from "../lib/verifier.js";

describe("parseVerifierResponse", () => {
  it("parses a well-formed CONFIRMED verdict", () => {
    const json = JSON.stringify({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com", "https://b.com"]
    });
    const out = parseVerifierResponse(json);
    expect(out).toEqual({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com", "https://b.com"]
    });
  });

  it("filters non-string source_urls", () => {
    const json = JSON.stringify({
      verdict: "inconclusive",
      evidence_summary: "x",
      source_urls: ["https://a.com", 42, null, "https://b.com"]
    });
    const out = parseVerifierResponse(json);
    expect(out!.source_urls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("rejects unknown verdict", () => {
    const json = JSON.stringify({
      verdict: "maybe",
      evidence_summary: "x",
      source_urls: []
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseVerifierResponse("not json")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `npm test -- verifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/verifier.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  VERIFIER_PROMPT,
  buildVerifierUserMessage
} from "../prompts/verifier-prompt.js";
import type { BraveSearchResult, ClaudeUsage, Verdict } from "../types/index.js";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing required env var: ANTHROPIC_API_KEY");
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 512;
const TEMPERATURE = 0.1;

const VALID_VERDICTS = new Set<Verdict>(["confirmed", "contradicted", "inconclusive", "error"]);

export interface ParsedVerifierResult {
  verdict: Verdict;
  evidence_summary: string;
  source_urls: string[];
}

function extractFirstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseVerifierResponse(rawText: string): ParsedVerifierResult | null {
  const jsonText = extractFirstJsonBlock(rawText);
  if (!jsonText) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict as Verdict)) return null;
  if (typeof obj.evidence_summary !== "string") return null;
  if (!Array.isArray(obj.source_urls)) return null;
  const source_urls = obj.source_urls.filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );
  return {
    verdict: obj.verdict as Verdict,
    evidence_summary: obj.evidence_summary,
    source_urls
  };
}

export interface VerifierSuccess {
  ok: true;
  result: ParsedVerifierResult;
  usage: ClaudeUsage;
}
export interface VerifierFailure {
  ok: false;
  reason: "parse_error";
  usage: ClaudeUsage;
}
export type VerifierCallResult = VerifierSuccess | VerifierFailure;

export async function verifyClaim(
  claim: string,
  searchResults: ReadonlyArray<BraveSearchResult>
): Promise<VerifierCallResult> {
  const userMessage = buildVerifierUserMessage(claim, searchResults);

  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: VERIFIER_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: userMessage }]
  });

  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }

  const usage: ClaudeUsage = {
    tokens_in: message.usage.input_tokens,
    tokens_out: message.usage.output_tokens,
    cached_tokens: message.usage.cache_read_input_tokens ?? 0
  };

  const parsed = parseVerifierResponse(text);
  if (!parsed) return { ok: false, reason: "parse_error", usage };
  return { ok: true, result: parsed, usage };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test -- verifier.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/verifier.ts tests/verifier.test.ts
git commit -m "Add verifier lib with parser tests"
```

---

## Task 9: /api/verify-claim endpoint

**Files:**
- Create: `api/verify-claim.ts`

- [ ] **Step 1: Implement the endpoint**

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import { searchClaim } from "../lib/brave-search.js";
import { verifyClaim } from "../lib/verifier.js";
import { supabaseService } from "../lib/supabase.js";
import type {
  VerifiableClaim,
  VerifyRequestBody
} from "../types/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidBody(raw: unknown): raw is VerifyRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  return (
    typeof b.analysis_id === "string" &&
    UUID_RE.test(b.analysis_id) &&
    typeof b.claim_index === "number" &&
    Number.isInteger(b.claim_index) &&
    b.claim_index >= 0
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "bad_request", message: "POST only" });
    return;
  }

  try {
    if (!isValidBody(req.body)) {
      res.status(400).json({ error: "bad_request", message: "invalid request body" });
      return;
    }
    const body = req.body;

    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // Ownership check via service role (bypasses RLS).
    const { data: analysis, error: lookupError } = await supabaseService
      .from("response_analyses")
      .select("user_id, verifiable_claims")
      .eq("id", body.analysis_id)
      .maybeSingle();

    if (lookupError) {
      console.error("[verify-claim] lookup failed", lookupError);
      res.status(500).json({ error: "internal" });
      return;
    }
    if (!analysis || analysis.user_id !== user.user_id) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const claims = (analysis.verifiable_claims ?? []) as VerifiableClaim[];
    const claim = claims[body.claim_index];
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Unified quota — verifications count against the same monthly counter as analyses.
    const quota = await incrementResponseAnalysesQuota(user.user_id);
    if (quota.exceeded) {
      res.status(429).json({ error: "quota_exceeded", limit: quota.limit, used: quota.used });
      return;
    }

    const start = Date.now();

    const search = await searchClaim(claim.claim);
    if (!search.ok) {
      console.error("[verify-claim] brave search failed", { reason: search.reason });
      res.status(500).json({ error: "internal" });
      return;
    }

    let verifierResult;
    try {
      verifierResult = await verifyClaim(claim.claim, search.results);
    } catch (err) {
      console.error("[verify-claim] haiku error", err);
      res.status(500).json({ error: "internal" });
      return;
    }

    const latency_ms = Date.now() - start;

    if (!verifierResult.ok) {
      console.error("[verify-claim] verifier parse_error");
      res.status(500).json({ error: "internal" });
      return;
    }

    const { result, usage } = verifierResult;

    const { data: insertRow, error: insertError } = await supabaseService
      .from("claim_verifications")
      .insert({
        analysis_id: body.analysis_id,
        claim_index: body.claim_index,
        user_id: user.user_id,
        verdict: result.verdict,
        evidence_summary: result.evidence_summary,
        source_urls: result.source_urls,
        search_tokens_used: search.results.length,
        haiku_tokens_in: usage.tokens_in,
        haiku_tokens_out: usage.tokens_out,
        latency_ms
      })
      .select("id")
      .single();

    if (insertError || !insertRow) {
      console.error("[verify-claim] insert failed", insertError);
      res.status(500).json({ error: "internal" });
      return;
    }

    res.status(200).json({
      verdict: result.verdict,
      evidence_summary: result.evidence_summary,
      source_urls: result.source_urls,
      verification_id: insertRow.id as string
    });
  } catch (err) {
    console.error("[verify-claim] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add api/verify-claim.ts
git commit -m "Add /api/verify-claim endpoint"
```

---

## Task 10: test-curl.sh — cases 9 and 10

**Files:**
- Modify: `test-curl.sh`

- [ ] **Step 1: Append case 9 (claim extraction)**

After the existing case 8 block (before the final `Done.` echo), append:

```bash
# ---------------------------------------------------------------------------
# Case 9 — Claim extraction. Response with multiple verifiable claims:
# a fabricated-looking citation, a current-state role claim, a date.
# Expectation: skip=false, verifiable_claims has at least 2 entries with
# proper anchored_to verbatim substrings, plus prompt_versions in payload.
# Saves analysis_id for case 10.
# ---------------------------------------------------------------------------
echo
echo "=== 9. claim extraction / OpenAI leadership ==="
CASE9_BODY='{
  "prompt": "Tell me about the recent OpenAI leadership change.",
  "response": "In March 2024, Sam Altman returned as CEO after a brief departure. According to a 2024 Bloomberg report, the company has now reached 200 million weekly active users on ChatGPT. The CTO position is held by Mira Murati.",
  "platform": "chatgpt",
  "conversation_id": "test-conv-9",
  "message_id": "test-msg-9"
}'

CASE9_RESPONSE=$(curl -sS -X POST "$BASE_URL/api/analyze-response" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
  -d "$CASE9_BODY")

echo "--- analyze response ---"
echo "$CASE9_RESPONSE" | (command -v jq >/dev/null && jq . || cat)

CASE9_ANALYSIS_ID=$(echo "$CASE9_RESPONSE" | (command -v jq >/dev/null \
  && jq -r '.analysis_id // empty' \
  || sed -n 's/.*"analysis_id":"\([^"]*\)".*/\1/p'))

# ---------------------------------------------------------------------------
# Case 10 — Verify claim. Picks the first verifiable_claim from case 9
# and runs /api/verify-claim against it. Expectation: 200 with verdict,
# evidence_summary, source_urls, verification_id.
# ---------------------------------------------------------------------------
if [[ -n "$CASE9_ANALYSIS_ID" && "$CASE9_ANALYSIS_ID" != "null" ]]; then
  CLAIM_INDEX=$(echo "$CASE9_RESPONSE" | (command -v jq >/dev/null \
    && jq -r '
      (.verifiable_claims // [])
      | to_entries
      | map(select(.value.risk == "high"))
      | (.[0].key // 0)' \
    || echo 0))
  echo
  echo "=== 10. verify-claim (analysis_id=$CASE9_ANALYSIS_ID, claim_index=$CLAIM_INDEX) ==="
  curl -sS -X POST "$BASE_URL/api/verify-claim" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TEST_TOKEN" \
    -H "Origin: chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef" \
    -d "{\"analysis_id\":\"$CASE9_ANALYSIS_ID\",\"claim_index\":$CLAIM_INDEX}" \
    | (command -v jq >/dev/null && jq . || cat)
else
  echo "Case 10 skipped — no analysis_id from case 9."
fi
```

- [ ] **Step 2: Run the full test suite locally**

Pre-reqs: `vercel dev` running, `TEST_TOKEN` exported.

```bash
bash test-curl.sh
```

Expected:
- Cases 1–8 unchanged (still pass; cases 1, 4, 5, 6, 7 also now show `verifiable_claims` arrays).
- Case 9 returns `skip:false` with `verifiable_claims` length ≥ 2.
- Case 10 returns a JSON `{verdict, evidence_summary, source_urls, verification_id}`.

- [ ] **Step 3: Capture cases 9 and 10 output for the user**

```bash
bash test-curl.sh 2>&1 | tee /tmp/case-9-10.log
```

Then extract:
```bash
sed -n '/=== 9\./,/=== 10\./p' /tmp/case-9-10.log
sed -n '/=== 10\./,$p' /tmp/case-9-10.log
```

- [ ] **Step 4: Commit**

```bash
git add test-curl.sh
git commit -m "Add test-curl cases 9 (claim extraction) and 10 (verify)"
```

---

## Task 11: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add new section "Claim verification"**

Append (or insert in the natural ToC position) the following section:

```markdown
## Claim verification

The analyzer runs two prompts in parallel on every non-gated request:

1. **Validator** (`prompts/system-prompt.ts`, currently `SYSTEM_PROMPT_VERSION`) — gap-spotting, returns `validations[]`.
2. **Claim extractor** (`prompts/claim-extractor-prompt.ts`, `CLAIM_EXTRACTOR_VERSION`) — surfaces verifiable factual claims, returns `verifiable_claims[]`.

Both Haiku calls are dispatched via `Promise.allSettled`. If one fails, the other's results still ship; the response payload reflects the partial success. If both fail, the request returns 500.

### On-demand verification

`POST /api/verify-claim` takes `{analysis_id, claim_index}`, looks up the corresponding claim from `verifiable_claims`, runs a Brave Search query, then asks Haiku for a verdict (`confirmed | contradicted | inconclusive | error`). Result + evidence + source URLs are persisted to `claim_verifications`.

### Local setup

Add to `.env.local`:

```
BRAVE_API_KEY=<your key>
```

Sign up for a free Brave Search API key at https://api.search.brave.com (2000 queries/month). Verifications and analyses share the same monthly per-user quota counter (`response_analyses` in `user_usage`).

### Quota and cost notes

- Free tier ceiling is 2000 Brave queries / month per project. There is no automatic backoff yet — when you approach the limit, watch logs for `[brave-search] non-2xx { status: 429 }` and either upgrade or reduce traffic.
- Each verify call costs: 1 Brave query + 1 Haiku call (max 512 output tokens, temperature 0.1). Roughly $0.001 per verification at current pricing.

### Monitoring

Verification verdict distribution:

```sql
select verdict, count(*) from claim_verifications group by verdict;
```

Per-prompt drop-rate (claims dropped because anchor wasn't verbatim) lives in logs only — grep for `[claim-extractor] dropping claim`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document claim verification architecture"
```

---

## Final verification

- [ ] **Run typecheck once more:** `npm run typecheck` — expect clean.
- [ ] **Run all unit tests:** `npm test` — expect all green (existing + new).
- [ ] **Run `test-curl.sh` end-to-end:** all 10 cases produce expected output.
- [ ] **Verify in DB** (Supabase SQL Editor):

```sql
-- A recent analysis should have prompt_version=v17 and claim_extractor_version=v1
select id, prompt_version, claim_extractor_version,
       jsonb_array_length(validations) as v_count,
       jsonb_array_length(verifiable_claims) as c_count
from response_analyses
order by created_at desc
limit 5;

-- The verify call should appear here
select id, analysis_id, claim_index, verdict, latency_ms, created_at
from claim_verifications
order by created_at desc
limit 5;
```

- [ ] **Paste back to user:**
  - Case 9's `verifiable_claims` array.
  - Case 10's full response (`verdict`, `evidence_summary`, `source_urls`, `verification_id`).
  - Confirmation that `prompt_version=v17` and `claim_extractor_version=v1` appear in `response_analyses`.

- [ ] **Stop. Do not deploy** — defer to user.

---

## Out of scope (do NOT touch)

- Chrome extension UI changes (separate project / separate prompt).
- Sycophancy detector (separate phase).
- Verification result caching (every verify call hits Brave fresh — accepted).
- Background pre-fetching of verifications.
- Hallucination as part of `validations` (fully separated; lives only in `verifiable_claims`).
