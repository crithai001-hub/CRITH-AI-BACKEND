# Frontend integration brief — `/api/ask-crith` (2026-06-01)

The backend endpoint is live on the `feat/frontend-contract-consolidation` branch. Use this brief to verify the extension is wired correctly and to diagnose any failures.

## Why this brief exists

Backend logs show **zero `ask_crith` rows in Supabase as of 2026-06-01**. Either the extension isn't reaching the endpoint, or every call fails before the DB insert. This brief tells you exactly what to check, in order, until you find which.

## The contract

### Endpoint

```
POST <BASE>/api/ask-crith
Authorization: Bearer <supabase access_token>
Content-Type: application/json
```

`<BASE>` must match the Vercel deployment that has this branch. **Production (`main`) does NOT have this endpoint yet.** If your `API_BASE_URL` points at the production domain, all calls 404. Either repoint to the preview URL for `feat/frontend-contract-consolidation`, or wait until the branch is merged to main.

### Request

```ts
{
  selected_text:   string,  // 40..5000 chars, must contain a space
  context_before:  string,  // 0..200 chars (verbatim text immediately before the selection)
  context_after:   string,  // 0..200 chars (verbatim text immediately after)
  prompt:          string,  // 0..2000 chars (originating user message; "" if none)
  platform:        "chatgpt" | "claude" | "gemini" | "perplexity" | "grok" | "deepseek",
  conversation_id: string,
  message_id:      string   // "ask-<sessionId>-<sel_len>-<rand>"
}
```

Any violation (wrong type, length out of range, unknown platform, missing field) returns **400 with no DB row written**. If you suspect 400 is firing silently, log the raw response body in the extension — the backend returns `{ error: "bad_request", message: "invalid request body" }`.

### Success response

```ts
{
  skip: false,
  validations: Validation[],
  suppressed: Validation[],
  flags: Flag[],
  inline_flag_id: string | null,
  verifiable_claims: EnrichedVerifiableClaim[],
  analysis_id: string,
  prompt_versions: {
    validator: "ask-v1",
    claim_extractor: "ask-claim-v1"
  }
}
```

Byte-for-byte the same as `AnalyzeResponseSuccess`. Your existing renderer should treat it identically.

**New in 2026-06-01: inline verification.** Each `EnrichedVerifiableClaim` with `hallucination_signal` of `high` or `medium` (i.e., `verify: true`) now arrives with the verdict pre-attached:

```ts
{
  // existing fields...
  verify: true,
  hallucination_signal: "high" | "medium",

  // present when ask-crith ran the verifier inline:
  verdict?: "confirmed" | "contradicted" | "inconclusive" | "error",
  evidence?: string,
  source_urls?: string[],
  verification_id?: string
}
```

Render the verdict directly from these fields. **Fallback:** if `verdict` is absent on a `verify: true` claim (quota ran out mid-ask, or inline verify failed), keep calling `/api/verify-claim` the way you do today — the contract is unchanged.

### Skip response

```ts
{ skip: true, reason: SkipReason, analysis_id: string }
```

New `SkipReason` values to handle:
- `"ask_too_short"` — selection under 40 chars or no whitespace.
- `"ask_pure_syntax"` — bare URL, code-dominated block, or greeting-only.
- `"ask_no_substance"` — model returned nothing critique-worthy and no claims to verify.

Reused: `"parse_error"`, `"claude_error"`, `"quota_exceeded"`.

### Errors

- `401` → `{ error: "unauthorized" }` — JWT missing/expired. Treat as AUTH_REQUIRED.
- `429` → `{ error: "quota_exceeded", limit: number, used: number }` — **no `message` field**. Halt further asks for the session.
- `400` → `{ error: "bad_request", message: string }` — fix the request body.
- `500` → `{ error: "internal" }` — backend log will say why.

## Quota model

One ask = 1 unit. Inline verification of N eligible claims = N more units (max 3, since extractor caps claim count). So a fact-check-heavy selection can cost up to 4 quota units. Use the same shared monthly counter as `/api/analyze-response`.

If quota runs out mid-ask, claims that were verified in time get verdicts; the rest arrive with `verify: true` but no `verdict` field. Frontend should still render the claim card and let the user click to call `/api/verify-claim` (which will also 429 — that's the cue to stop).

## Step-by-step verification

Run this checklist in order. The first failure tells you where the integration is broken.

### Step 1 — Confirm the backend URL is reachable

Open a terminal and run:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "<BASE>/api/health"
```

- `200` → backend is up.
- `404` → wrong URL. The deployment doesn't exist at this domain. Check Vercel dashboard for the correct preview URL of `feat/frontend-contract-consolidation`.
- `5xx` → backend is up but unhealthy. Check Vercel function logs.

### Step 2 — Confirm `/api/ask-crith` is deployed at that URL

```bash
curl -sS -X POST "<BASE>/api/ask-crith" -H "Content-Type: application/json" -d '{}' -o /tmp/resp -w "%{http_code}\n"
cat /tmp/resp
```

- `400` with `{"error":"bad_request","message":"invalid request body"}` → endpoint exists. Move on.
- `401` → endpoint exists, just rejecting unauth requests early (this can happen depending on order; treat as success for this step).
- `404` → endpoint not deployed at this URL. Production hasn't been updated; you're hitting `main` not the preview. Either repoint or ask backend to merge to `main`.
- `405` → endpoint is at that path but doesn't accept POST (very unlikely). Probably a path collision.

### Step 3 — Confirm auth works

Grab a fresh Supabase JWT for a test user, then:

```bash
curl -sS -X POST "<BASE>/api/ask-crith" \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "selected_text": "Most startups fail in their first year because founders refuse to validate their assumptions before writing code, and 73% of teams that skip discovery interviews end up rebuilding within six months.",
    "context_before": "Sure! Here is what I think about your idea: ",
    "context_after": " That is why discovery matters.",
    "prompt": "What do you think of my SaaS idea?",
    "platform": "chatgpt",
    "conversation_id": "smoke-1",
    "message_id": "ask-smoke-1-220-abc"
  }' | jq .
```

Expected: a JSON body with `skip: false`, an `analysis_id`, and probably 1–3 `verifiable_claims` (the 73% stat is the prime candidate). At least one claim should have a `verdict` field populated (likely `inconclusive` or `confirmed`).

- If you see `verifiable_claims[0].verdict`: inline verify works end-to-end. ✓
- If you see claims but no `verdict` field: inline verify either failed silently or hit quota. Check the request again with a fresh JWT.
- If you see `"error":"unauthorized"`: the JWT is stale. Regenerate.

### Step 4 — Confirm the extension actually hits the URL

In the extension's network inspector, click "Ask CRITH" on a real AI response with a fact in it. Confirm:

- A POST request fires to `<BASE>/api/ask-crith`.
- The request body has all 7 required fields (none undefined or empty where length > 0 is required).
- The response status is 200.

If no request fires at all: the click handler isn't reaching the API client, or `ASK_CRITH_MOCK` is still `true` somewhere.

If the request fires but the URL is wrong: your config has the wrong `<BASE>`. The extension is hitting an endpoint that 404s; your error handler is probably swallowing it.

### Step 5 — Verify the verdict renders

If steps 1–4 pass, the renderer is the last suspect. Confirm in your code:

- The claim card reads `claim.verdict` (not `claim.evidence_summary` from the older `/api/verify-claim` path).
- The `verify: true` filter still works — the verdict fields are only attached to eligible claims.
- Source URL click-through handles both formats: raw publisher (`https://nytimes.com`) and Gemini grounding redirect (`https://vertexaisearch.cloud.google.com/grounding-api-redirect/...`).

## Common failure modes and what they mean

| Symptom | Likely cause | Fix |
|---|---|---|
| 404 on every ask | `<BASE>` is production URL but ask-crith isn't merged to main | Repoint to the preview URL, or ask backend to merge |
| 401 with valid-looking JWT | JWT expired or wrong project | Get a fresh token, verify Supabase project matches backend |
| 400 with no clear message | One of the 7 request fields is the wrong type or out of range | Log the raw request body in the extension; compare against the contract above |
| 200 success but no verdict on claims | Inline verify silently failed (Gemini quota or network) | Backend logs will have `[ask-crith-inline-verify]` lines. Frontend should fall back to `/api/verify-claim` |
| 429 immediately | Test user has exhausted monthly quota | Reset or use a different test user |
| Skip with `ask_too_short` you didn't expect | Selection is under 40 chars or has no whitespace | Confirm extension's pre-filter matches: 40 char minimum, must contain a space |
| Skip with `ask_pure_syntax` you didn't expect | Selection is a bare URL, ≥85% code fences, or only greeting tokens | Adjust the extension's pre-filter or accept the skip |

## What's in Supabase you can use to debug

If you have access to the Supabase project, two queries help:

```sql
-- Did your ask actually reach the backend?
select id, analysis_kind, skipped, skip_reason,
       jsonb_array_length(coalesce(verifiable_claims, '[]'::jsonb)) as n_claims,
       latency_ms, created_at
from public.response_analyses
where analysis_kind = 'ask_crith'
order by created_at desc
limit 10;
```

If this returns zero rows for the past hour despite you clicking "Ask CRITH" 10 times, the requests aren't reaching the backend at all. Stop debugging the response handling; the URL or auth is wrong.

```sql
-- Did inline verification actually run?
select id, verdict, latency_ms, jsonb_array_length(source_urls) as n_sources, created_at
from public.claim_verifications
order by created_at desc
limit 10;
```

If `response_analyses` has ask_crith rows but `claim_verifications` has no recent rows, the verifier is failing (most likely Gemini API key issue in Vercel env).

## What to tell backend if step 1 or 2 fails

If the endpoint isn't reachable: send the backend the exact `<BASE>` you're using and the curl output. Likely they need to either redeploy the preview or merge to main.

If the endpoint is reachable but every call 500s: send the backend a `verification_id` or `analysis_id` from a failed call (or the timestamp range). They'll look up the Vercel function logs for the matching request.
