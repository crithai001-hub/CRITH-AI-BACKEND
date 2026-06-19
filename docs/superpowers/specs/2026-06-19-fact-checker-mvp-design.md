# Fact-Checker MVP — Design

**Date:** 2026-06-19
**Status:** approved for planning
**Supersedes:** the entire validator / flags / provocations / `hallucination_signal` surface from `2026-04-29-response-analyzer-design.md` and downstream specs.

## Purpose

Replace the current Response Analyzer (validator + claim extractor + on-demand verifier) with a pure fact-checker MVP. The product's single promise becomes: **before you publish or rely on something an AI told you, we tell you whether the falsifiable parts hold up against real, recent sources.**

The wedge is the publishing safety net. The hero failure modes are:

1. **Fabricated citations** — a paper, case, or URL that doesn't exist or doesn't say what the AI claimed.
2. **Fabricated quotes** — attributions that were never said or were said by someone else.
3. **Stale statistics and facts** — claims that were true once and have quietly become wrong.

Subjective territory — "X is the best way to do Y", recommendations, reasoning gaps — is explicitly **out of scope** for the MVP. False positives on contested opinions would dilute the only promise the product can make defensibly.

## Non-goals

- Critical-thinking provocations, validators, gap-spotting, "hidden assumption" flags.
- Hallucination-signal gating that auto-fires verification.
- Prescriptive / normative claim evaluation ("X is the best way") — V2.
- Frontend implementation (separate brief).
- Migration of the existing Chrome extension (clean break; extension is rewritten against the new contract).

## Architecture

Two extraction endpoints surface claims. One verification endpoint judges a single claim against grounded Google Search results. All three call **Gemini** as the only LLM provider; Brave Search and Anthropic Claude are removed. Persistence is Supabase (existing tables, repurposed).

```
ext auto path:   AI response  →  /api/fact-check           →  claims[]
ext user path:   selection    →  /api/fact-check-selection →  claims[]
ext on click:    claim_index  →  /api/verify-claim         →  verdict + evidence + sources
```

### Why two extraction endpoints

The two extraction paths have meaningfully different prompts and constraints:

- **`fact-check`** sees the full prompt + response + (optional) conversation history. It ranks claims by importance across the whole response.
- **`fact-check-selection`** sees a highlighted slice plus boundary context (text before, text after, originating prompt). Claims must be anchored strictly inside the selection; context blocks are treated as data, not source.

We tried unifying these earlier (the `ask-crith` rebuild) and learned the prompts diverge enough that one shared prompt drifts on both jobs. Keeping them separate is the lesson.

### Why Gemini-only

Gemini's built-in Google Search grounding tool collapses our previous two-step verification (Brave Search → Anthropic Haiku verdict) into one call: pass a claim, get back a verdict with cited URLs. Single provider, single key, simpler ops. We lose Anthropic prompt-caching on the extraction prompt — acceptable for the MVP; revisit if extraction cost becomes a problem.

## Endpoints

### `POST /api/fact-check`

Auto-fired by the extension on every AI response.

**Request**
```ts
{
  prompt: string;
  response: string;
  platform: "chatgpt" | "claude" | "gemini" | "perplexity" | "grok" | "deepseek";
  conversation_id: string;
  message_id: string;
  conversation_history?: Array<{ role: "user" | "assistant"; content: string }>;
  // Last 6 turns of prior conversation. Server-capped at 6 entries / 1500 chars each.
}
```

**Response — extracted**
```ts
{
  skip: false,
  analysis_id: string,
  claims: Claim[],         // 0 to 3 entries
  prompt_version: string   // extractor prompt version
}
```

**Response — skipped**
```ts
{
  skip: true,
  reason: SkipReason,
  analysis_id: string
}
```

**Errors**
```
401 { error: "unauthorized" }
500 { error: "internal" }
```

Quota is **not consumed** by this endpoint. See "Quota" below.

### `POST /api/fact-check-selection`

User-initiated on a highlighted slice.

**Request**
```ts
{
  selected_text: string;   // 40 — 5000 chars
  context_before: string;  // <= 200 chars
  context_after: string;   // <= 200 chars
  prompt: string;          // <= 2000 chars
  platform: Platform;
  conversation_id: string;
  message_id: string;
}
```

**Response** — same shape as `/api/fact-check`. Skip reasons differ (e.g. `selection_too_short`, `selection_pure_syntax`). Anchors MUST satisfy `selected_text.includes(anchored_to)`; a server-side post-check drops claims whose anchor drifts into context.

Quota is **not consumed** by this endpoint.

### `POST /api/verify-claim`

Fires when the user clicks a highlighted claim in the extension.

**Request**
```ts
{
  analysis_id: string;     // uuid
  claim_index: number;     // integer >= 0
}
```

**Response — verified**
```ts
{
  verdict: Verdict,
  evidence: string,        // 2-3 sentence evidence summary
  source_urls: string[],   // grounded URLs from Gemini
  as_of_date: string,      // YYYY-MM-DD — the date the verifier judged this true/false as of
  was_true_until?: string, // YYYY-MM-DD — present only when the claim was once true and no longer is
  verification_id: string,
  follow_up_prompt: string // first-person prompt the user can fire back at the AI
}
```

**Errors**
```
401 { error: "unauthorized" }
404 { error: "not_found" }              // analysis_id or claim_index invalid for user
429 { error: "quota_exceeded", limit, used }
500 { error: "internal" }
```

This is the **only** metered endpoint. See "Quota".

## Types

```ts
export type ClaimType = "citation" | "quote" | "statistic" | "factual";

export type Verdict =
  | "found_supporting"
  | "found_contradicting"
  | "could_not_verify"
  | "error";

export type Platform =
  | "chatgpt" | "claude" | "gemini" | "perplexity" | "grok" | "deepseek";

export type SkipReason =
  | "trivial"
  | "code"
  | "factual_lookup"        // the user asked a one-shot factual question; no analysis
  | "extracted_nothing"     // valid response, no falsifiable claims — not an error
  | "selection_too_short"
  | "selection_pure_syntax"
  | "parse_error"
  | "gemini_error";

export interface Claim {
  claim_id: string;
  claim_index: number;
  analysis_id: string;
  claim_text: string;       // clean, searchable restatement of the claim
  anchored_to: string;      // verbatim 30-80 char substring of response/selection
  claim_type: ClaimType;
  why_check: string;        // names the specific falsifiable element (paper title, number, attribution, ...)
}
```

Removed types: `Validation`, `Flag`, `Lens`, `Severity`, `Provocation`, `HallucinationSignal`, `Risk`, `FlagTier`, the `Lens` enum, the 10-value `ClaimType` enum, the `EnrichedVerifiableClaim` extra fields. The Chrome extension is rewritten against the new contract; no backwards-compatibility shims on the wire.

## Claim types — what the extractor and verifier do per type

The extractor labels every claim with one of four types so the verifier can load the right framing block. The labels are also useful telemetry — we want to know how often the wedge claim types (citation, quote, statistic) appear vs the generic catch-all.

| Type | What it covers | Verifier framing |
|------|----------------|------------------|
| `citation` | Reference to a paper, study, report, book, case, court ruling, URL, or other named document. | **Existence check.** Does the cited document exist? Does it say what the AI claimed? An uncited "according to a 2023 McKinsey study" is the canonical bad case. |
| `quote` | Direct quote attributed to a person or organization. | **Attribution check.** Did this person actually say this? In what venue, when? Was it said by someone else? |
| `statistic` | Specific numeric claim — market sizes, percentages, prices, rankings, growth rates, etc. | **Value check, recency-biased.** What is the current value, from what source, when was it last updated? Was the AI's number ever right? When did it stop being right? |
| `factual` | Catch-all for everything verifiable that isn't one of the above: named people in roles, dates, technical facts, API limits, product features, current-state claims, definitions, sequences of events. | **Generic fact check, recency-biased.** Is this true today, per recent sources? |

The verifier prompt is one document with four framing blocks selected by `claim_type`. The framing block changes the search query and the verdict reasoning, not the output schema.

## Extractor behavior — precision over recall

The extractor's prompt enforces:

1. **Drop, don't pad.** Hard rule: return zero claims if the response has nothing falsifiable. Soft / vague / "most companies" / "generally" content is not a claim. `extracted_nothing` is a normal skip reason, not an error.
2. **Cap at 3 claims.** Cost ceiling, applied after the precision filter.
3. **`why_check` is a gate.** The field must name the specific falsifiable element — the paper title, the number, the named person, the attributed quote. If `why_check` would read "general factual statement" or "common knowledge worth confirming", the claim is not falsifiable enough and must be dropped.
4. **Anchor discipline.** Every `anchored_to` is a verbatim 30-80 char substring of the response (or, for selection mode, the selection). A server-side post-check drops anchors that don't pass `response.includes(anchored_to)`.
5. **Prompt-injection defense.** All user-controlled content is wrapped in clear XML-like blocks (`<response>`, `<selection>`, `<context_before>`, etc.) and the four closing tags are neutralized with a zero-width space before substitution — same pattern as the current `ask-crith` extractor.

## Verifier behavior — recency-aware and honest

The verifier prompt enforces:

1. **Default verdict is `could_not_verify`.** Absence of recent supporting sources is `could_not_verify`, not `found_supporting`. The prompt says this explicitly: "Do not assert truth. Report what the search results actually show."
2. **Recency bias in the search query.** Gemini's grounded search is instructed to prefer recent results (`after:2024`, `2025..2026`, "current", "today" qualifiers depending on claim type).
3. **`as_of_date` is always set.** It's the date the verifier judged the claim as of — typically today. For staleness cases, it's "today" and `was_true_until` is populated with the year the claim stopped being current.
4. **`was_true_until` populated when staleness is the cause.** If the claim was once true and is no longer current, verdict is `found_contradicting` and `was_true_until` is the year/month the claim ceased to be true (per the most recent contradicting source). If the verifier can't pin a date, leave it unset.
5. **`follow_up_prompt`** is a first-person prompt the user can fire back at the AI ("Earlier you said X — I couldn't find a primary source for that, can you cite it?"). Max 450 chars. Plain prose, no markdown.
6. **Verdict choice for each label:**
   - `found_supporting` — multiple credible recent sources directly support the claim.
   - `found_contradicting` — multiple credible sources directly contradict the claim, OR the claim was once true and recent sources show it no longer holds.
   - `could_not_verify` — search results don't directly address the claim, are mixed/conflicting, or are low-credibility.
   - `error` — search returned nothing usable, or the verifier failed to produce JSON.

## Quota

**Successful `/api/verify-claim` calls are the only metered events.**

- Extraction (`/api/fact-check`, `/api/fact-check-selection`) is uncounted.
- Trigger-gate skips are uncounted (no Gemini call).
- Parse errors and Gemini API errors are uncounted on extraction *and* on verification — we don't charge the user when our infra fails.
- A successful verification (verdict returned, row persisted) decrements the monthly counter.

This is a deliberate change from the V1 policy "track Anthropic spend, not user value". Rationale:

- For a fact-checker, **the verification is the product moment.** Extraction is a precondition; making it free means the auto-extraction path can't drain the budget the user actually wants to spend on verifications.
- Errors on our side feel like product bugs when they cost the user a quota slot. Eating the cost is the right call until error rate is provably tiny.

`user_usage.response_analyses` continues as the counter column. Rename in a later migration if we want; for now, reuse for continuity.

## Trigger gate (server-side)

Same pure-function gate as today, scoped to the fact-check job:

- `trivial` — word count < 80.
- `code` — code fence > 85% of response.
- `factual_lookup` — common-prefix pattern + < 8 words + single `?`. The user asked the AI a quick factual lookup; nothing to fact-check.

Selection-mode adds:

- `selection_too_short` — fewer than ~40 characters.
- `selection_pure_syntax` — selection is all punctuation / symbols / code (no prose tokens).

`extracted_nothing` is set **after** Gemini returns zero claims. It's not a gate skip; it's a normal post-extraction outcome.

## Persistence

We reuse two existing tables — `response_analyses` and `claim_verifications` — for analytics continuity. Migration drops unused columns at the schema level later; the MVP just stops writing them.

### `response_analyses` — fields the new flow writes

```
id                 uuid
user_id            uuid
platform           text
conversation_id    text
message_id         text
prompt_length      int
response_length    int
skipped            bool
skip_reason        text       (SkipReason enum)
claim_count        int        (renamed in spirit from provocation_count; same column)
tokens_in          int        (Gemini)
tokens_out         int        (Gemini)
latency_ms         int
prompt_version     text       (extractor prompt version)
claims             jsonb      (the Claim[] returned to the client; reusing verifiable_claims column)
original_prompt    text
original_response  text
conversation_history_turn_count   int
conversation_history_chars        int
analysis_kind      text       — values: "fact_check" | "fact_check_selection"
ask_context_before text        (selection mode only)
ask_context_after  text        (selection mode only)
created_at         timestamptz
```

Fields we stop writing: `provocations`, `validations`, `suppressed_validations`, `claim_extractor_version`, `claim_extractor_tokens_in`, `claim_extractor_tokens_out`, `cached_tokens` (Gemini grounding tier doesn't cache the same way).

### `claim_verifications` — new fields

```
id                 uuid
analysis_id        uuid
claim_index        int
user_id            uuid
verdict            text       (Verdict enum — new values)
evidence_summary   text
source_urls        text[]
follow_up_prompt   text
as_of_date         date       — NEW
was_true_until     date NULL  — NEW
gemini_tokens_in   int
gemini_tokens_out  int
latency_ms         int
created_at         timestamptz
```

Fields we stop writing: `search_tokens_used`, `haiku_tokens_in`, `haiku_tokens_out`, `search_query` (Gemini grounding doesn't expose the literal query the way Brave did — we can log Gemini's grounding metadata if it gives us anything equivalent, but it isn't load-bearing).

### Migration plan

One Supabase migration adds `as_of_date` and `was_true_until` to `claim_verifications`. No column drops in this migration — leave the deprecated columns in place, just stop writing. A separate cleanup migration can drop them once we're confident.

## What gets deleted

Endpoints removed: `/api/explain-provocation`, `/api/summarize-flags`, `/api/ask-crith` (replaced by `/api/fact-check-selection`), `/api/analyze-response` (replaced by `/api/fact-check`).

`lib/` modules removed: `explainer.ts`, `summarizer.ts`, `flag-pipeline.ts`, `flag-resolution.ts`, `inline-pick.ts`, `inline-verify.ts` (logic folded into the verifier directly), `claim-extractor.ts` (replaced by Gemini extractor), `claude.ts`, `ask-crith-claude.ts`, `verifier.ts` (replaced by Gemini verifier), `brave-search.ts`, `triggers.ts` (replaced by fact-check gate), `ask-crith-triggers.ts` (folded into the selection-mode gate), `validate-history.ts` keeps purpose but is reused.

`prompts/` removed: `system-prompt.ts`, `explainer-system-prompt.ts`, `summary-report-prompt.ts`, `claim-extractor-prompt.ts`, `verifier-prompt.ts`, `ask-crith-extractor-prompt.ts`, `ask-crith-validator-prompt.ts`.

`prompts/` added: `fact-check-extractor-prompt.ts` (auto mode), `fact-check-selection-extractor-prompt.ts` (selection mode), `fact-check-verifier-prompt.ts` (with the four framing blocks).

Types removed: `Validation`, `Flag`, `Lens`, `Severity`, `Provocation`, `HallucinationSignal`, `Risk`, `FlagTier`, the existing `ClaimType` and `Verdict` enums (replaced), `ClaudeAnalysisResult`, `PromptVersions`, `EnrichedVerifiableClaim`, the entire flags / suppressed / validations field family on the response shapes.

Env vars removed: `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`.
Env vars added: `GEMINI_API_KEY`.

Dependencies removed: `@anthropic-ai/sdk`.
Dependencies added: `@google/genai`.

## New lib structure

```
lib/
  auth.ts              — unchanged
  cors.ts              — unchanged
  supabase.ts          — unchanged
  quota.ts             — counter logic changes (see Quota above); structure unchanged
  validate-history.ts  — reused for /api/fact-check conversation history
  gemini.ts            — Gemini client + extractor + verifier wrappers
  fact-check-gate.ts   — pure-function trigger gate for /api/fact-check
  fact-check-selection-gate.ts — pure-function gate for selection mode
  anchor.ts            — verbatim-substring guarantee + zero-width terminator neutralizer
prompts/
  fact-check-extractor-prompt.ts
  fact-check-selection-extractor-prompt.ts
  fact-check-verifier-prompt.ts
api/
  fact-check.ts
  fact-check-selection.ts
  verify-claim.ts      — rewritten against Gemini
  health.ts            — unchanged
  user-plan.ts         — unchanged
  stripe-webhook.ts    — unchanged
```

## Testing

### Unit (Vitest)

- Trigger gate (`fact-check-gate`, `fact-check-selection-gate`): every skip reason has at least one positive and one negative test case.
- Extractor parser: malformed JSON → parse error path returns `{ ok: false }` without throwing.
- Extractor anchor post-check: drops claims whose `anchored_to` is not a substring of input.
- Verifier parser: same — malformed → parse error.
- `as_of_date` / `was_true_until` parsing: ISO-date validation.
- Quota: a successful verification decrements; a parse error does not.

### Smoke (`test-curl.sh`)

Refresh the script to cover:

1. **Fabricated citation.** AI response includes "According to a 2023 McKinsey study showing 73%..." with no specific paper. Expect: 1 claim, `claim_type: citation`, verdict `could_not_verify` or `found_contradicting`.
2. **Stale fact (the Sam Altman door-to-door case).** Response says "the best way to find early customers is door-to-door outreach, per Sam Altman's startup school". Expect: extractor labels as `factual` or `quote` depending on framing. Verifier finds the original true-at-the-time guidance and contemporary contradicting data; verdict `found_contradicting` with `was_true_until` populated.
3. **Correct fact.** "Sam Altman is the CEO of OpenAI." Verdict `found_supporting`, `as_of_date` set, no `was_true_until`.
4. **No claims.** Response is pure advice / opinion ("you should plan carefully and validate early"). Expect: `skip: true, reason: "extracted_nothing"`.
5. **Code response.** Code-fence > 85%. Expect: `skip: true, reason: "code"`.
6. **Trivial.** Short reply ("Yes, that works."). Expect: `skip: true, reason: "trivial"`.
7. **Selection — pure syntax.** User highlights `{}, [];`. Expect: `skip: true, reason: "selection_pure_syntax"`.
8. **Selection — fabricated quote.** User highlights "As Steve Jobs said: 'Real artists ship and ship often.'" Expect: 1 claim, `claim_type: quote`, verdict `found_contradicting` (the actual phrase is "real artists ship").
9. **Selection — successful extraction with anchor in context.** Selection is short, but the claim worth flagging is in `context_after`. Expect: extractor returns no claim from the selection (anchor must be in selection); `skip: true, reason: "extracted_nothing"`.

### Manual verification

Before declaring the fact-check loop done, run two real-world responses from ChatGPT and Claude through the extension end-to-end and confirm the verdicts read honestly — that "could_not_verify" actually appears when sources are thin, that `was_true_until` actually populates on a known-stale case.

## Open questions

- **Gemini grounding cost per call.** Need to confirm against current pricing (Jan 2026) before we commit to "verification is the metered event". If cost is too high, fall back to capped quota.
- **Conversation history in `/api/fact-check`.** Keep the existing 6-turn / 1500-char caps until we see Gemini behave well or poorly with them — Anthropic-tuned caps may not be optimal.
- **Migration timing for the deprecated columns.** Drop in a separate migration once the new flow has run for a week without writing to them.

## Out of scope (V2 candidates)

- Prescriptive / normative claim evaluation ("X is the best way to Y").
- Hallucination-signal-style auto-fire of verifications.
- Multi-claim batch verification endpoint.
- Per-response sub-quotas separate from monthly.
- Frontend rendering / extension rewrite (separate brief).
