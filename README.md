# Crith AI V2 — Backend (Fact-Checker MVP)

Backend for the Crith AI Chrome extension's fact-checker. Takes an AI assistant's response (or a user-highlighted slice), extracts the few most likely-wrong claims, and verifies each against Google Search — all in one call. On user click, `/api/verify-claim` performs a deeper manual re-check.

Stack: Vercel Node serverless functions, Supabase (auth + RLS-protected logging + monthly quotas), Gemini 2.5 Flash with built-in Google Search grounding.

## Setup

```bash
npm install
cp .env.example .env.local
# Fill in GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

Apply migrations to your Supabase project (latest is `0015_verification_trigger.sql`):

```bash
supabase db push
```

Run locally:

```bash
npm run dev        # vercel dev on http://localhost:3000
npm test           # unit tests
npm run typecheck  # tsc --noEmit
```

## Endpoints

### `POST /api/fact-check`

Auto-fired by the extension on every AI response. Extracts AND verifies claims in one Gemini call (Google Search grounding enabled, ~3–5 s typical, 10 s hard cap). Each returned claim embeds a `verification` object — no second round-trip needed.

```ts
// Request
{
  prompt: string,
  response: string,
  platform: "chatgpt" | "claude" | "gemini" | "perplexity" | "grok" | "deepseek",
  conversation_id: string,
  message_id: string,
  conversation_history?: Array<{ role: "user" | "assistant", content: string }>
}

// Response — claims extracted and auto-verified
{
  skip: false,
  analysis_id: string,
  claims: VerifiedClaim[],   // each claim includes an embedded verification object
  prompt_version: string     // "v3"
}

// Response — gated or nothing to verify
{ skip: true, reason: SkipReason, analysis_id: string }
```

`VerifiedClaim` shape:

```ts
{
  claim_id: string,
  claim_index: number,
  analysis_id: string,
  claim_text: string,
  anchored_to: string,
  claim_type: "factual" | "prescriptive",
  claim_subtype: "citation" | "statistic" | "quote" | "entity" | "general",
  why_check: string,
  verification: {
    verdict: "supported" | "contradicted" | "unverified",
    evidence: string,
    source_urls: string[],
    as_of_date: string,          // YYYY-MM-DD
    was_true_until?: string,     // YYYY-MM — only when staleness is the cause
    follow_up_prompt?: string,   // ready-to-send correction; absent when verdict is supported
    verification_id?: string     // absent if the claim_verifications insert failed
  }
}
```

Skip reasons: `trivial`, `code`, `factual_lookup`, `extracted_nothing`, `parse_error`, `gemini_error`. Quota is NOT consumed by this endpoint. Auto-verifications are persisted to `claim_verifications` with `trigger='auto'`.

### `POST /api/fact-check-selection`

User-initiated on a highlighted slice. Same combined extract+verify contract as `/api/fact-check` (10 s hard cap), scoped to the highlighted selection.

```ts
// Request
{
  selected_text: string,   // 40 — 5000 chars
  context_before: string,  // <= 200 chars
  context_after: string,   // <= 200 chars
  prompt: string,          // <= 2000 chars
  platform: Platform,
  conversation_id: string,
  message_id: string
}

// Response — same shape as /api/fact-check (skip: false with VerifiedClaim[], or skip: true)
```

Selection-mode skip reasons add `selection_too_short` and `selection_pure_syntax`. Quota NOT consumed. Auto-verifications persisted with `trigger='auto'`.

### `POST /api/verify-claim`

Manual deep re-check — fires when the user clicks a highlighted claim to request a fresh verification. This is the only quota-metered endpoint. Verifications are persisted with `trigger='manual'`.

```ts
// Request
{ analysis_id: string, claim_index: number }

// Response
{
  verdict: "supported" | "contradicted" | "unverified" | "error",
  evidence: string,
  source_urls: string[],
  as_of_date: string,        // YYYY-MM-DD
  was_true_until?: string,   // YYYY-MM — only when staleness is the cause
  verification_id: string,
  follow_up_prompt?: string
}
```

Successful, persisted verifications consume one quota unit each; errors do not.

## Design decisions

- **One-call auto-verify.** `/api/fact-check` and `/api/fact-check-selection` now extract and verify in the same grounded Gemini call. The 10 s hard cap keeps latency acceptable; `thinkingBudget: 0` eliminates chain-of-thought overhead.
- **Trigger column.** `claim_verifications.trigger` distinguishes `'auto'` (combined call) from `'manual'` (user-clicked re-check via `/api/verify-claim`).
- **Recency awareness.** The verifier always populates `as_of_date`. When a claim was once true and is no longer current, verdict is `contradicted` and `was_true_until` carries the year/month it stopped being true. Search queries are recency-biased.
- **Honest verdict labels.** Verdicts are `supported | contradicted | unverified`. An assertive verdict (`supported` or `contradicted`) without at least one source is downgraded to `unverified`. The default is `unverified`. Absence of recent supporting sources is never upgraded to `supported`.
- **Drop, don't pad.** The extractor returns 0 claims when nothing is falsifiable. `extracted_nothing` is a normal outcome, not an error.
- **Quota policy.** Verifications count when fully persisted. Extraction/auto-verify does not. Errors do not. We eat the cost of our own infra failures.
- **CORS.** Permissive `chrome-extension://*` during dev. Locked-down regex tracked in `lib/cors.ts`.

## Test JWT

```bash
node --env-file=.env.local scripts/get-test-jwt.mjs me@example.com mypassword
```

Then:

```bash
export TEST_TOKEN=$(node --env-file=.env.local scripts/get-test-jwt.mjs me@example.com mypassword)
./test-curl.sh
```

## Layout

```
api/
  fact-check.ts
  fact-check-selection.ts
  verify-claim.ts
  health.ts
  events.ts
  user-plan.ts
  stripe-webhook.ts
lib/
  auth.ts
  cors.ts
  supabase.ts
  quota.ts
  validate-history.ts
  anchor.ts
  gemini.ts
  fact-check-gate.ts
  fact-check-selection-gate.ts
prompts/
  fact-check-combined-prompt.ts
  fact-check-selection-combined-prompt.ts
  fact-check-verifier-prompt.ts
types/index.ts
supabase/migrations/  — 0001 → 0015
tests/                — Vitest
test-curl.sh
docs/superpowers/specs/2026-07-15-auto-verify-fact-check-design.md
docs/superpowers/plans/2026-07-15-auto-verify-fact-check.md
```
