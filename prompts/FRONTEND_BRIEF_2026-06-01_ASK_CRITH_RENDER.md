# Frontend rendering brief — `/api/ask-crith` is fact-check-only (2026-06-01)

The backend now does **all** the fact-checking work for `/api/ask-crith`. The frontend should be a thin renderer of the response shape — no second API call, no client-side verdict synthesis, no fallback to `/api/verify-claim` for ask-crith analyses.

This brief tells you exactly what arrives on the wire, what to display, and what to ignore.

## The new ask-crith contract

`/api/ask-crith` is now a fact-checker. When the user clicks the "Ask CRITH" pill on a selection:

1. Backend extracts factual claims from the selection (statistics, citations, named people, dates, prices, technical specs, AI recommendations, etc).
2. For every claim with `hallucination_signal` of `high` or `medium` — i.e., the non-obvious facts — backend runs the Gemini-grounded search + Haiku verifier inline.
3. Each claim returns with `verdict`, `evidence`, `source_urls`, and `verification_id` already attached.
4. If the selection has no extractable facts, backend returns `skip: true, reason: "ask_no_substance"`.

**Backend no longer runs the reasoning-gap validator on ask-crith requests.** The fields `validations`, `suppressed`, `flags`, and `inline_flag_id` are still in the response shape for backward compat, but they will always be empty / null. Don't render anything from them.

## The exact wire shape

### Success — claims found and verified

```ts
{
  skip: false,

  // ALWAYS empty / null on ask-crith responses. Do not render.
  validations: [],
  suppressed: [],
  flags: [],
  inline_flag_id: null,

  // The real payload.
  verifiable_claims: EnrichedVerifiableClaim[],

  analysis_id: string,
  prompt_versions: {
    validator: "not_run",
    claim_extractor: "ask-claim-v1"
  }
}
```

Each entry in `verifiable_claims`:

```ts
{
  // The factual statement, restated for searching:
  claim: string,
  claim_text: string,  // identical to claim, legacy alias
  claim_id: string,
  claim_index: number,
  analysis_id: string,

  // The substring of selected_text the claim refers to:
  anchored_to: string,

  // What kind of claim it is:
  claim_type: "statistic" | "citation" | "person_or_role" | "date" |
              "product_or_pricing" | "current_state" | "quote" |
              "technical_fact" | "ai_mistake" | "actionable_recommendation",

  // How likely it's a fabrication / stale:
  hallucination_signal: "high" | "medium" | "none",
  hallucination_reason: string,  // short phrase, e.g. "round number, no source"

  // Consequence-if-false:
  risk: "high" | "medium" | "low",

  why_verify: string,  // one-sentence reason

  // True iff the backend ran inline verification on this claim. Always true
  // when verdict is populated; false when hallucination_signal === "none".
  verify: boolean,

  // Inline-verification fields. PRESENT on claims the backend verified.
  // ABSENT on claims with hallucination_signal === "none" (= obvious facts).
  verdict?: "confirmed" | "contradicted" | "inconclusive" | "error",
  evidence?: string,
  source_urls?: string[],
  verification_id?: string
}
```

### Skip — no facts in the selection

```ts
{
  skip: true,
  reason: "ask_no_substance" | "ask_too_short" | "ask_pure_syntax" |
          "parse_error" | "claude_error" | "quota_exceeded",
  analysis_id: string
}
```

Show the user a small "Nothing to fact-check in that selection" message (or your own copy). The `reason` field is for telemetry; users only care about the friendly message.

## How to render

For each entry in `verifiable_claims`:

### Has `verdict` field

This is a verified claim. Render the claim card with the verdict prominent:

| `verdict` value | UI treatment |
|---|---|
| `"confirmed"` | Green check, "Verified", show `evidence` and link to `source_urls[0]` |
| `"contradicted"` | Red X, "Contradicted by sources", show `evidence`, link sources |
| `"inconclusive"` | Yellow caution, "Couldn't verify", show `evidence` (often "no strong sources found") |
| `"error"` | Gray, "Verification error" — typically meta-claims about AI output that can't be externally verified. Show `hallucination_reason` instead of `evidence` |

The `evidence` field is human-readable prose (1–3 sentences). Show it directly. `source_urls` is an array — show the first 1–3 as clickable links; both raw URLs (`https://nytimes.com`) and Gemini grounding redirect URLs (`https://vertexaisearch.cloud.google.com/grounding-api-redirect/...`) work the same way — just an `<a href={url} target="_blank">`. Use `new URL(url).hostname` for the displayed link text.

### Does NOT have `verdict` field (`verify: false`)

This claim was extracted but flagged as a widely-known/obvious fact that doesn't need verification. **Do not render it as a claim card.** It's not actionable for the user. Filter these out before rendering:

```ts
const renderable = response.verifiable_claims.filter((c) => c.verdict !== undefined);
```

If `renderable.length === 0`, treat the response like a skip — show "Nothing to fact-check in that selection."

### Inline underline on the AI's response

For each renderable claim, underline `claim.anchored_to` inside the user's original selection. `anchored_to` is **guaranteed to be a verbatim substring of `selected_text`** — server enforces this twice. Your existing `text.includes(anchor)` logic works without changes.

## What NOT to do

1. **Do not call `/api/verify-claim` for ask-crith analyses.** The verdict is already in the response. Calling `/api/verify-claim` would re-spend quota for the same verification and produce no new info.

2. **Do not synthesize verdicts client-side from `hallucination_reason` or `why_verify`.** That was the old contract before inline verification existed. The backend now gives you the real verdict; trust it.

3. **Do not render anything from `validations`, `suppressed`, `flags`, or `inline_flag_id`.** They will always be empty on ask-crith responses. If your renderer is showing "reasoning gaps" or "hidden assumptions" cards on ask-crith requests, that's stale rendering logic from the analyze-response path leaking in. Conditionalize on the endpoint: ask-crith responses go through the claim-card path only.

4. **Do not show claims with `verdict` absent.** Those are filter-out cases (obvious facts the backend chose not to verify). Showing them with no verdict produces a confusing empty card.

## End-to-end happy path

1. User selects "73% of teams that skip discovery interviews end up rebuilding within six months" on an AI response.
2. Extension fires `POST /api/ask-crith` with the selection.
3. Backend's extractor identifies this as a `statistic` claim with `hallucination_signal: "high"` (round number, no source).
4. Backend runs `searchClaim` (Gemini grounding) → returns 5 results.
5. Backend runs `verifyClaim` (Haiku reads the results, decides) → `verdict: "inconclusive", evidence: "No authoritative source found for the specific 73% figure; common but uncited in startup discovery literature."`
6. Backend writes to `claim_verifications` table and returns the enriched claim.
7. Frontend receives `verifiable_claims[0]` with `verdict: "inconclusive"`, `evidence: "..."`, `source_urls: [...]`.
8. Frontend underlines the stat in the selection, shows a yellow-caution claim card with the evidence text and source links.
9. Total time: 5–10 seconds. No second API call.

## Where things can go wrong, and the diagnostic SQL

If the user clicks "Ask CRITH" and nothing happens / no verdict shows:

**Check 1 — did the request reach the backend?**

```sql
select id, skipped, skip_reason,
       jsonb_array_length(coalesce(verifiable_claims, '[]'::jsonb)) as n_claims,
       latency_ms, created_at
from public.response_analyses
where analysis_kind = 'ask_crith'
order by created_at desc
limit 5;
```

- Zero rows for the past hour → request isn't reaching the backend. Check `VITE_BACKEND_URL` and CORS.
- Rows with `skipped = true` → backend decided there was nothing to fact-check. Check the `skip_reason`.
- Rows with `n_claims > 0` → extractor found claims; next check.

**Check 2 — did inline verification run?**

```sql
select cv.id, cv.verdict, cv.latency_ms,
       jsonb_array_length(cv.source_urls) as n_sources,
       cv.created_at
from public.claim_verifications cv
join public.response_analyses ra on ra.id = cv.analysis_id
where ra.analysis_kind = 'ask_crith'
order by cv.created_at desc
limit 5;
```

- Rows exist with verdicts → backend verified. Issue is rendering. Inspect the JSON the extension received and compare to the shape above.
- No rows → inline verification didn't run. Backend logs will say why (`[ask-crith-inline-verify]` lines).

**Check 3 — what did the response actually look like?**

In the extension's network inspector, find the POST to `/api/ask-crith`, copy the response JSON, and verify against the shape in this brief. Common drift:
- `verifiable_claims: []` → no claims extracted; show "nothing to check" UI.
- `verifiable_claims[0].verdict === undefined` → backend chose not to verify (`hallucination_signal: "none"`). Filter out before rendering.
- `verifiable_claims[0].verdict === "error"` → claim was about AI output meta (broken markdown, repetition) — show `hallucination_reason` instead of `evidence`.

## TL;DR

- Render `verifiable_claims.filter(c => c.verdict !== undefined)`.
- Show verdict + evidence + first source URL per claim.
- Ignore `validations`, `suppressed`, `flags`, `inline_flag_id`.
- Don't call `/api/verify-claim` — verdicts are already in the response.
- On `skip: true`, show a short "nothing to fact-check" message.

If something still doesn't work, paste the raw response JSON from a real click into the backlog and the backend will trace it to the specific failure.
