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
npm run dev      # vercel dev on http://localhost:3000
npm test         # unit tests
npm run build    # type-check
```

## Endpoints

### `POST /api/analyze-response`

```ts
// Request
{
  prompt: string;
  response: string;
  platform: "chatgpt" | "claude" | "gemini";
  conversation_id: string;
  message_id: string;
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

You need a Supabase JWT to call the protected endpoints. Easiest path:

```ts
// scripts/get-test-jwt.ts (or paste into a Node REPL)
import { createClient } from "@supabase/supabase-js";
const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const { data } = await c.auth.signInWithPassword({
  email: "test@example.com",
  password: "your-test-password"
});
console.log(data.session!.access_token);
```

Or sign in via Supabase Studio → Authentication → Users.

Export it for `test-curl.sh`:

```bash
export TEST_TOKEN=eyJhbGciOi...
./test-curl.sh
```

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

### 4. Reset a test user's quota

When a test user hits the limit during tuning:

```sql
delete from user_usage where user_id = '<uuid>';
-- or just zero out the current month:
update user_usage set response_analyses = 0
where user_id = '<uuid>' and month_key = to_char(now(), 'YYYY-MM');
```

## Project layout

```
api/                 — Vercel serverless function handlers
  analyze-response.ts
  events.ts
lib/                 — shared helpers
  auth.ts            — Supabase JWT validation
  claude.ts          — Anthropic client + analyzer
  cors.ts            — CORS regex + preflight
  quota.ts           — atomic monthly upsert (race-condition note inside)
  supabase.ts        — anon + service-role clients
  triggers.ts        — pure-function trigger gate
prompts/
  system-prompt.ts   — SYSTEM_PROMPT + SYSTEM_PROMPT_VERSION
types/index.ts       — shared TS types
supabase/migrations/
  0001_initial.sql   — tables, view, RLS
tests/               — Vitest unit tests (triggers, quota.monthKey)
test-curl.sh         — 4 sanity-check cases
docs/superpowers/specs/2026-04-29-response-analyzer-design.md
```
