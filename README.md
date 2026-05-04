# Crith AI V2 — Backend

Backend for the Response Analyzer feature: takes an AI assistant's response (ChatGPT, Claude, Gemini) and the user's original prompt, returns 0–3 critical-thinking provocations.

Stack: Vercel Node serverless functions, Supabase (auth + RLS-protected logging + monthly quotas), Anthropic Claude Haiku 4.5 with prompt caching.

## Setup

```bash
npm install
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

Apply the migration to your Supabase project:

```bash
# Via Supabase CLI
supabase db push

# Or paste supabase/migrations/0001_initial.sql into the SQL editor
```

Run locally:

```bash
npm run dev        # vercel dev on http://localhost:3000
npm test           # unit tests
npm run typecheck  # tsc --noEmit (renamed from "build" so Vercel doesn't run it during deploy)
```

## Endpoints

### `POST /api/analyze-response`

```ts
// Request
{
  prompt: string;
  response: string;
  platform: "chatgpt" | "claude" | "gemini" | "perplexity" | "grok" | "deepseek";
  conversation_id: string;
  message_id: string;
  conversation_history?: Array<{ role: "user" | "assistant"; content: string }>;
  // ↑ optional. Last 6 turns of prior conversation. Capped server-side at
  //   6 entries / 1500 chars each. See "Conversation context" below.
}

// Response (analyzed)
{ skip: false, provocations: Provocation[], analysis_id: string }

// Response (skipped — gate, parse error, or quota)
{ skip: true, reason: "trivial"|"code"|"factual"|"parse_error"|"quota_exceeded", analysis_id: string }

// Errors
401 { error: "unauthorized" }
429 { error: "quota_exceeded", limit, used }
500 { error: "internal" }
```

### `POST /api/events`

```ts
{
  analysis_id: string;
  provocation_index: number;          // 0-based, must exist on the analysis
  event_type: "shown" | "expanded" | "sent_to_ai" | "dismissed" | "copied";
}
```

## Design decisions

- **Quota policy:** trigger-gate skips don't count. Parse errors and Claude API errors do — they spent tokens. Gives a metric to watch high-error users.
- **Trigger gate (server-side):** word count < 80, code-fence > 85% of response, factual lookup (prefix + < 8 words + single `?`). Tightened from the original 70% / no-word-cap so real strategy questions are not gated away.
- **Prompt versioning:** `SYSTEM_PROMPT_VERSION` is logged on every row so engagement metrics can be sliced by version during tuning. Bump it when the prompt content changes.
- **Truncation:** head-only, first ~3000 tokens (~12000 chars). No head+tail splice — the lenses look for argument structure, not conclusion-specific signals.
- **CORS:** permissive `chrome-extension://*` during dev. TODO comment in `lib/cors.ts` flags the lockdown to a specific extension ID before public Web Store launch.

## Tuning Workflow

The system prompt will need iteration. This section is the operational playbook.

### 1. Get a test JWT

Use the bundled helper. Requires Node 20.6+ for `--env-file`:

```bash
# .env.local must contain SUPABASE_URL and SUPABASE_ANON_KEY
node --env-file=.env.local scripts/get-test-jwt.mjs me@example.com mypassword
```

Pipe straight to clipboard and into the test runner:

```bash
export TEST_TOKEN=$(node --env-file=.env.local scripts/get-test-jwt.mjs me@example.com mypassword)
./test-curl.sh
```

Or against the deployed backend:

```bash
export BASE_URL="https://your-deployment.vercel.app"
./test-curl.sh
```

Create the test user via Supabase Studio → Authentication → Users → Add user (email + password) before running.

### 2. Bump the prompt version

When you change the system prompt:

1. Edit `prompts/system-prompt.ts`.
2. Bump `SYSTEM_PROMPT_VERSION` (e.g. `"v1"` → `"v2"`).
3. Deploy.
4. All subsequent `response_analyses` rows are tagged with the new version automatically.

You can compare versions side-by-side because old rows keep their original tag.

### 3. Sample analytics queries

Run these from Supabase Studio → SQL editor.

**Recent provocations grouped by lens × prompt_version:**

```sql
select
  prompt_version,
  jsonb_path_query(provocations, '$[*].lens') #>> '{}' as lens,
  count(*) as n
from response_analyses
where created_at > now() - interval '7 days'
  and skipped = false
  and provocations is not null
group by 1, 2
order by 1, 3 desc;
```

**Engagement rate (events per analysis) by lens, last 30 days:**

```sql
with analyses as (
  select id, prompt_version
  from response_analyses
  where created_at > now() - interval '30 days' and skipped = false
)
select
  pe.lens,
  a.prompt_version,
  count(distinct pe.analysis_id) as analyses_with_engagement,
  count(*) filter (where pe.event_type = 'expanded') as expansions,
  count(*) filter (where pe.event_type = 'sent_to_ai') as sent_to_ai,
  count(*) filter (where pe.event_type = 'dismissed') as dismissed
from provocation_events pe
join analyses a on a.id = pe.analysis_id
group by 1, 2
order by 1, 2;
```

**Skip-reason distribution over the last 7 days:**

```sql
select
  coalesce(skip_reason, 'analyzed') as outcome,
  count(*) as n,
  round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from response_analyses
where created_at > now() - interval '7 days'
group by 1
order by 2 desc;
```

If `trivial` / `code` / `factual` rates look wrong, re-tune the gate in `lib/triggers.ts`. If `parse_error` is non-trivial, the prompt is producing malformed JSON — usually a sign the system prompt drifted.

**Cache hit rate (aggregate) — last 24 hours:**

```sql
select
  prompt_version,
  count(*) as analyses,
  sum(tokens_in) as total_input_tokens,
  sum(cached_tokens) as cached_input_tokens,
  round(100.0 * sum(cached_tokens) / nullif(sum(tokens_in), 0), 1) as cache_hit_pct
from response_analyses
where created_at > now() - interval '24 hours'
  and skipped = false
group by 1
order by 1;
```

Cache hit rate should be > 80% within minutes of warmup. If it stays low, the system prompt has a silent invalidator (timestamp, request ID, non-deterministic key order). See `shared/prompt-caching.md` in the brainstorming docs for the audit checklist.

**Latency percentiles by prompt version:**

```sql
select
  prompt_version,
  percentile_cont(0.5)  within group (order by latency_ms) as p50_ms,
  percentile_cont(0.95) within group (order by latency_ms) as p95_ms,
  percentile_cont(0.99) within group (order by latency_ms) as p99_ms,
  count(*) as n
from response_analyses
where created_at > now() - interval '7 days'
  and skipped = false
group by 1
order by 1;
```

### 4. Conversation context (analyzer v12+)

`conversation_history` lets the analyzer see prior turns of the conversation it's analyzing. Without it, the model treats every turn as if the user just opened the chat — so anything the user already specified in turn 1 (audience, scale, budget, jurisdiction) gets falsely flagged as a "hidden assumption" when the AI references it in a later turn. With it, those false positives go away and the analyzer can also catch new failure modes like the AI contradicting itself across turns or dropping a thread the user raised earlier.

**Caps:** server-side, hardcoded in `lib/validate-history.ts`:

- max 6 turns (oldest dropped first if more are sent)
- max 1500 chars per turn (truncated with `[...]` suffix)

These are deliberately tight to keep the analyzer's input-token cost predictable. Revisit if Supabase data shows the model is missing context that would have fit comfortably (e.g. average turn length is 200 chars but key context lives in a single 2000-char turn that gets cut).

**Test it:**

Case 7 in `test-curl.sh` is the regression scenario. The user specifies their audience upfront, then asks for pricing two turns later. Pre-v12 the analyzer flagged the audience as assumed; under v12 it should not. Run the suite and confirm case 7's provocations focus on the pricing logic, not the audience.

**See what's being sent in production:**

```sql
select
  prompt_version,
  count(*)                                          as analyses,
  avg(conversation_history_turn_count)::numeric(10,2) as avg_turns,
  avg(conversation_history_chars)::numeric(10,2)      as avg_chars,
  sum(case when conversation_history_turn_count > 0 then 1 else 0 end) as with_context
from response_analyses
where created_at > now() - interval '7 days'
group by prompt_version
order by prompt_version;
```

If `with_context` stays at 0 even after extension v12.x rollout, the extension isn't sending the field. If `avg_turns` is consistently < 6 but `with_context` is high, users genuinely have short conversations — caps are not the limiting factor. If `avg_chars` hits the cap (~9000 = 6 × 1500) every time, raise the per-turn cap.

### 5. Reset a test user's quota

When a test user hits the limit during tuning:

```sql
delete from user_usage where user_id = '<uuid>';
-- or just zero out the current month:
update user_usage set response_analyses = 0
where user_id = '<uuid>' and month_key = to_char(now(), 'YYYY-MM');
```

## Claim verification

The analyzer runs two prompts in parallel on every non-gated request:

1. **Validator** (`prompts/system-prompt.ts`, `SYSTEM_PROMPT_VERSION`) — gap-spotting, returns `validations[]`.
2. **Claim extractor** (`prompts/claim-extractor-prompt.ts`, `CLAIM_EXTRACTOR_VERSION`) — surfaces verifiable factual claims, returns `verifiable_claims[]`.

Both Haiku calls are dispatched via `Promise.allSettled`. If one fails, the other's results still ship (logged but non-fatal). If both fail, the request returns 500. The two calls share a single quota slot.

The success payload includes:

```ts
{
  skip: false,
  validations: Validation[],
  verifiable_claims: VerifiableClaim[],
  analysis_id: string,
  prompt_versions: { validator: "v17", claim_extractor: "v1" }
}
```

### On-demand verification

`POST /api/verify-claim` body:

```ts
{ analysis_id: string; claim_index: number }
```

Looks up the corresponding claim from `verifiable_claims`, runs a Brave Search query, asks Haiku for a verdict (`confirmed | contradicted | inconclusive | error`). Result + evidence + source URLs are persisted to `claim_verifications`.

### Local setup

Add to `.env.local`:

```
BRAVE_API_KEY=<your key>
```

Sign up for a free Brave Search API key at https://api.search.brave.com (2000 queries/month). Verifications and analyses share the same monthly per-user quota counter (`response_analyses` in `user_usage`).

### Quota and cost notes

- Free tier ceiling is 2000 Brave queries / month. No automatic backoff yet — watch logs for `[brave-search] non-2xx { status: 429 }`.
- Each verify call costs: 1 Brave query + 1 Haiku call (max 512 output tokens, T=0.1). Roughly $0.001 per verification at current pricing.

### Monitoring

```sql
select verdict, count(*) from claim_verifications group by verdict;
```

Dropped-claim diagnostics live in logs only — grep deployments for `[claim-extractor] dropping claim`.

## Project layout

```
api/                       — Vercel serverless function handlers
  analyze-response.ts
  events.ts
  explain-provocation.ts
  verify-claim.ts
lib/                       — shared helpers
  auth.ts                  — Supabase JWT validation
  brave-search.ts          — Brave Search REST client
  claim-extractor.ts       — Haiku claim-extractor wrapper + parser
  claude.ts                — Anthropic client + validator analyzer
  cors.ts                  — CORS regex + preflight
  explainer.ts             — provocation explainer
  quota.ts                 — atomic monthly upsert (race-condition note inside)
  supabase.ts              — anon + service-role clients
  triggers.ts              — pure-function trigger gate
  verifier.ts              — Haiku verifier wrapper + parser
prompts/
  system-prompt.ts         — SYSTEM_PROMPT + SYSTEM_PROMPT_VERSION
  claim-extractor-prompt.ts — CLAIM_EXTRACTOR_PROMPT + version
  verifier-prompt.ts       — VERIFIER_PROMPT + version
  explainer-system-prompt.ts
types/index.ts             — shared TS types
supabase/migrations/       — 0001 → 0006
tests/                     — Vitest unit tests (parsers, triggers, quota)
test-curl.sh               — 10 sanity-check cases (analyzer + verify)
docs/superpowers/specs/2026-04-29-response-analyzer-design.md
docs/superpowers/plans/2026-05-03-claim-verification.md
```
