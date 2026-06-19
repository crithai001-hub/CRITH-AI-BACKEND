# Crith AI V2 — Backend (Fact-Checker MVP)

Backend for the Crith AI Chrome extension's fact-checker. Takes an AI assistant's response (or a user-highlighted slice) and surfaces falsifiable factual claims; on user click, returns a recency-aware verdict for the claim grounded in Google Search.

Stack: Vercel Node serverless functions, Supabase (auth + RLS-protected logging + monthly quotas), Gemini 2.5 Flash with built-in Google Search grounding.

## Setup

```bash
npm install
cp .env.example .env.local
# Fill in GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

Apply migrations to your Supabase project (latest is `0013_fact_check_persistence_fixes.sql`):

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

Auto-fired by the extension on every AI response.

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

// Response — claims extracted
{ skip: false, analysis_id: string, claims: Claim[], prompt_version: string }

// Response — gated or post-extraction skip
{ skip: true, reason: SkipReason, analysis_id: string }
```

Skip reasons: `trivial`, `code`, `factual_lookup`, `extracted_nothing`, `parse_error`, `gemini_error`. Quota is NOT consumed by this endpoint.

### `POST /api/fact-check-selection`

User-initiated on a highlighted slice.

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
```

Selection-mode skip reasons add `selection_too_short` and `selection_pure_syntax`. Quota NOT consumed.

### `POST /api/verify-claim`

Fires when the user clicks a highlighted claim.

```ts
// Request
{ analysis_id: string, claim_index: number }

// Response
{
  verdict: "found_supporting" | "found_contradicting" | "could_not_verify" | "error",
  evidence: string,
  source_urls: string[],
  as_of_date: string,       // YYYY-MM-DD
  was_true_until?: string,  // YYYY-MM-DD — only when staleness is the cause
  verification_id: string,
  follow_up_prompt: string
}
```

This is the ONLY metered endpoint. Successful, persisted verifications consume one quota unit each; errors do not.

## Design decisions

- **Recency awareness.** The verifier always populates `as_of_date`. When a claim was once true and is no longer current, verdict is `found_contradicting` and `was_true_until` carries the year/month it stopped being true. Search queries are recency-biased.
- **Honest verdict labels.** No "confirmed" / "contradicted" oracle language. The default is `could_not_verify`. Absence of recent supporting sources is `could_not_verify`, not `found_supporting`.
- **Drop, don't pad.** The extractor returns 0 claims when nothing is falsifiable. `extracted_nothing` is a normal outcome, not an error.
- **Quota policy.** Verifications count when fully persisted. Extraction does not. Errors do not. We eat the cost of our own infra failures.
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
  fact-check-extractor-prompt.ts
  fact-check-selection-extractor-prompt.ts
  fact-check-verifier-prompt.ts
types/index.ts
supabase/migrations/  — 0001 → 0013
tests/                — Vitest
test-curl.sh
docs/superpowers/specs/2026-06-19-fact-checker-mvp-design.md
docs/superpowers/plans/2026-06-19-fact-checker-mvp.md
```
