# Response Analyzer — Design

**Date:** 2026-04-29
**Project:** Crith AI V2 — Backend
**Status:** Approved with revisions (per brainstorming session 2026-04-29)

## 1. Purpose

A backend service that takes an AI assistant's response (from ChatGPT, Claude, or Gemini) and a user's original prompt, and returns 0–3 critical-thinking "provocations": questions that surface gaps, hidden assumptions, sycophancy, and missing angles. Powers the Response Analyzer feature of the Crith AI V2 Chrome extension.

This spec is the backend only. No Chrome extension code.

## 2. Architecture

Two stateless Vercel Node serverless functions backed by:
- **Supabase** — auth (JWT bearer), RLS-protected logging, monthly per-user quotas, single-source-of-truth analytics.
- **Anthropic Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) — analysis, with prompt caching on the system prompt.

No queues, no background jobs. Request lifecycle is fully synchronous: validate → gate → call Claude → log → return. This is a deliberate YAGNI decision — V2 volume does not justify async infrastructure.

## 3. File layout

```
/api
  analyze-response.ts       — main analysis endpoint
  events.ts                 — engagement event logging
/lib
  claude.ts                 — Anthropic client, model config, retry-on-parse-fail
  supabase.ts               — supabase clients (anon + service-role)
  auth.ts                   — getUserFromRequest helper
  triggers.ts               — pure-function trigger gate
  quota.ts                  — atomic upsert+increment, monthly counters
  cors.ts                   — chrome-extension://* origin matcher + preflight
/prompts
  system-prompt.ts          — SYSTEM_PROMPT constant + SYSTEM_PROMPT_VERSION
/types
  index.ts                  — shared TypeScript types
/supabase/migrations
  0001_initial.sql          — tables, view, RLS policies
package.json  tsconfig.json  vercel.json  .env.example
README.md  test-curl.sh
```

A small `/lib/cors.ts` module exists so the CORS regex + extension-ID TODO live in one place rather than duplicated across both endpoints.

## 4. Endpoints

### 4.1 `POST /api/analyze-response`

**Request body:**
```ts
{
  prompt: string;
  response: string;
  platform: "chatgpt" | "claude" | "gemini";
  conversation_id: string;
  message_id: string;
}
```

**Lifecycle:**
1. CORS preflight handling
2. Validate `Authorization: Bearer <jwt>` → resolve `user_id` (401 on failure)
3. Run trigger gate (`/lib/triggers.ts`). If skip:
   - Insert `response_analyses` row with `skipped=true, skip_reason=<reason>`
   - **Do not** touch `user_usage` (per Q2(B): trigger-gate skips don't count)
   - Return `{skip: true, reason, analysis_id}`
4. Atomic upsert+increment on `user_usage` for current `month_key`. If post-increment exceeds `FREE_RESPONSE_ANALYSES_MONTHLY_LIMIT`:
   - Insert `response_analyses` row with `skipped=true, skip_reason="quota_exceeded"`
   - Return 429 `{error: "quota_exceeded", limit, used}`
5. Truncate response to first ~3000 tokens (head-only — see §6)
6. Call Claude Haiku 4.5 with cached system prompt
7. Parse JSON. On parse fail, retry once with reminder. On second fail:
   - Insert row with `skipped=true, skip_reason="parse_error"` (quota stays incremented per Q2(B))
   - Return `{skip: true, reason: "parse_error", analysis_id}`
8. On Claude API error (network, rate limit, etc.):
   - Insert row with `skipped=true, skip_reason="claude_error"` (quota stays incremented)
   - Return 500 `{error: "internal"}`
9. Otherwise insert full row with provocations + return `{skip: false, provocations, analysis_id}`

**Response shapes:**
- `{skip: true, reason: "trivial"|"code"|"factual"|"parse_error"|"quota_exceeded", analysis_id}`
- `{skip: false, provocations: Provocation[], analysis_id}`
- `{error: "unauthorized"}` 401, `{error: "quota_exceeded", limit, used}` 429, `{error: "internal"}` 500

### 4.2 `POST /api/events`

**Request body:**
```ts
{
  analysis_id: string;
  provocation_index: number;
  event_type: "shown" | "expanded" | "sent_to_ai" | "dismissed" | "copied";
}
```

**Lifecycle:**
1. CORS preflight
2. Auth → user_id (401)
3. Service-role read of `response_analyses.user_id WHERE id = analysis_id`. If missing or doesn't match: 403 `{error: "forbidden"}`
4. Insert into `provocation_events` (lens + severity copied from the parent analysis at insert time, so events are queryable without join). Returns `{ok: true}`.

## 5. Trigger gate (`/lib/triggers.ts`)

Pure functions, no I/O. Tested with unit tests. Order: word count → code → factual. First match wins.

### 5.1 Word count
```
words = response.trim().split(/\s+/).length
if words < 80: return {skip: true, reason: "trivial"}
```

### 5.2 Code-heavy (threshold 85%)
```
codeChars = sum of chars inside ``` fences (matched non-greedy across newlines)
if codeChars / response.length > 0.85: return {skip: true, reason: "code"}
```
Threshold is 85% (not 70%) because "here's the code and here's why" responses contain analyzable reasoning we want to preserve. Reserve the gate for pure code dumps.

### 5.3 Factual lookup (tightened — all three required)
```
prefix matches: ^(what is|what's|who is|who's|define|convert|translate)\b
                OR simple-arithmetic pattern (digits + ops + optional "?")
prompt word count: < 8
question marks: exactly 1 (or 0 for arithmetic)

ALL THREE required → skip with reason "factual"
```
Tightened from the original spec to avoid over-firing on "what is the best go-to-market strategy for X" (29 words, exactly the kind of strategy question the analyzer is built for). False negatives (Haiku call on a trivia prompt) are cheap. False positives (gating real strategy questions) are expensive.

## 6. Truncation strategy

**Head-only.** Take first 3000 tokens (~12000 chars at 4 chars/token estimator). Append `\n\n[...truncated...]` marker. No tokenizer dependency — the rough char-based estimator is sufficient for a soft cap.

Rationale (per design revision): the lenses look for argument structure, not conclusion-specific signals. Splicing two non-contiguous chunks risks the model anchoring provocations to text that doesn't logically follow. Simpler is better.

## 7. Claude call config (`/lib/claude.ts`)

- Model: `claude-haiku-4-5-20251001`
- `max_tokens: 1024`
- `temperature: 0.3`
- System prompt: single block with `cache_control: {type: "ephemeral"}`
- User message: exact format string from spec
- Parse: extract first `{...}` block via regex, `JSON.parse`
- On parse fail: one retry with system message extended `\n\nIMPORTANT: Return ONLY a JSON object. No preamble, no markdown fences, no explanation.`
- Tokens used (`input_tokens`, `output_tokens`, `cache_read_input_tokens`) captured from API response and logged on every analysis row.

## 8. Prompt versioning

`/prompts/system-prompt.ts` exports:
```ts
export const SYSTEM_PROMPT_VERSION = "v1";
export const SYSTEM_PROMPT = `...`;
```

`response_analyses.prompt_version` (text, NOT NULL) is logged on every row. This enables sliced engagement metrics during prompt tuning. Bump the version string whenever the prompt content changes — non-negotiable.

## 9. Supabase schema (`0001_initial.sql`)

### `response_analyses`
| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| user_id | uuid fk auth.users | not null |
| platform | text | not null |
| conversation_id | text | not null |
| message_id | text | not null |
| prompt_length | int | char count |
| response_length | int | char count |
| skipped | bool | default false |
| skip_reason | text | populated when `skipped=true` |
| provocation_count | int | default 0 |
| tokens_in | int | from API response |
| tokens_out | int | |
| cached_tokens | int | from `cache_read_input_tokens` |
| latency_ms | int | server-measured |
| prompt_version | text | not null, e.g. "v1" |
| created_at | timestamptz | default `now()` |

### `provocation_events`
| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| analysis_id | uuid fk | response_analyses.id |
| provocation_index | int | not null |
| lens | text | denormalized from analysis |
| severity | text | denormalized from analysis |
| event_type | text | constrained via CHECK |
| created_at | timestamptz | default `now()` |

### `user_usage`
| column | type | notes |
|---|---|---|
| user_id | uuid fk auth.users | composite pk |
| month_key | text | composite pk, format `YYYY-MM` |
| pre_prompt_interceptions | int | default 0 (reserved) |
| response_analyses | int | default 0 |
| updated_at | timestamptz | default `now()` |

### View `provocation_engagement_with_email`
Joins `provocation_events → response_analyses → auth.users`, exposes email for analytics. Inherits RLS from underlying tables.

### RLS policies
- All three tables: `SELECT/UPDATE` allowed only `WHERE user_id = auth.uid()`
- All `INSERT` operations come from API code via service-role key (bypasses RLS by design — prevents users forging analyses, events, or quota counters)

### Quota flow
Single SQL statement:
```sql
INSERT INTO user_usage (user_id, month_key, response_analyses)
VALUES ($1, $2, 1)
ON CONFLICT (user_id, month_key)
DO UPDATE SET response_analyses = user_usage.response_analyses + 1,
              updated_at = now()
RETURNING response_analyses;
```
Compare returned count to `FREE_RESPONSE_ANALYSES_MONTHLY_LIMIT`. If greater, this request is over quota.

**Known limitation:** the upsert+check pattern is not strictly atomic across truly concurrent requests from the same user — under heavy concurrency a user could exceed the limit by 1–2 calls before quota enforcement kicks in. Documented as a code comment in `/lib/quota.ts`. Fix path when V2 volume justifies it: wrap in a SQL function with `SELECT ... FOR UPDATE` or use a Postgres advisory lock keyed on `user_id`.

## 10. Auth (`/lib/auth.ts`)

```ts
async function getUserFromRequest(req): Promise<{ user_id: string; email: string } | null>
```
Extracts `Authorization: Bearer <jwt>`, calls `supabaseAnon.auth.getUser(token)`, returns null on any failure (no token, malformed, expired, revoked).

Anon key for user-scoped operations. Service-role key only for inserts and quota updates that need to bypass RLS.

## 11. CORS (`/lib/cors.ts`)

Permissive `chrome-extension://*` origin during dev. Echoes the request `Origin` back if it matches `^chrome-extension:\/\/[a-z]{32}$`. Handles OPTIONS preflight with `Access-Control-Allow-Methods: POST, OPTIONS` and `Access-Control-Allow-Headers: authorization, content-type`.

```ts
// TODO: tighten to specific ALLOWED_EXTENSION_ID env var before public
// Chrome Web Store launch. Auth (Supabase JWT) is doing the real security
// work — wide-open CORS just means random origins waste preflights.
```

## 12. Environment variables (`.env.example`)

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
FREE_RESPONSE_ANALYSES_MONTHLY_LIMIT=30
```

Anon key needed in addition to service-role: anon for user JWT validation, service-role for privileged inserts.

## 13. Error handling

Single `try/catch` per handler. All thrown errors → `console.error(err)` (Vercel surfaces to dashboard) + `{error: "internal"}` 500. No Sentry/external logger for V2 launch — Supabase analytics + Vercel logs are sufficient.

## 14. Testing

- Unit tests for `/lib/triggers.ts` (pure functions — quick wins, no mocks)
- Unit tests for `/lib/quota.ts` `monthKey()` computation
- No mocked Claude integration tests — `test-curl.sh` is the integration test
- `test-curl.sh` cases:
  1. **Strategy response, should analyze:** ~250-word go-to-market response with confident-but-thin recommendations → expect 2–3 provocations
  2. **Trivia, factual skip:** "what is the capital of France" → `{skip: true, reason: "factual"}`
  3. **Code dump, code skip:** sorting function request, response is 90%+ code fence → `{skip: true, reason: "code"}`
  4. **High-quality response, expect restraint:** prompt that elicits a careful, well-hedged AI response → expect `{skip: true}` or 1 low-severity provocation. This is the "knows when not to invent gaps" test, critical for prompt tuning.

## 15. README "Tuning Workflow" section

Required content:
- How to get a test JWT (sign in via Supabase Studio or `supabase.auth.signInWithPassword` from a Node REPL; copy `access_token` to `$TEST_TOKEN`)
- How to bump prompt version (edit `SYSTEM_PROMPT_VERSION` in `/prompts/system-prompt.ts`, deploy, all subsequent rows tagged with new version)
- Sample analytics SQL queries:
  - Recent provocations grouped by `lens` and `prompt_version`
  - Engagement rate (events per analysis) by lens
  - Skip-reason distribution over the last 7 days
  - Cache hit rate (`cached_tokens / tokens_in` aggregate)
- How to reset a test user's quota (delete row from `user_usage`)

## 16. Out of scope (V2 launch)

- Chrome extension implementation
- Pre-prompt interception feature (column exists in `user_usage` for forward compatibility, no logic yet)
- Sentry / external error tracking
- Streaming responses from Claude
- Tool use / function calling
- Stripe / paid tier (free tier limit only, enforced via env var)
- Strict CORS lockdown to a specific extension ID
