# Auto-Verify Fact-Check — Design

**Date:** 2026-07-15
**Branch:** feat/fact-checker-mvp
**Status:** Approved by user (conversation, 2026-07-15)

## Problem

The current MVP splits fact-checking into two user-visible steps: `/api/fact-check`
extracts claims, then the user must click each claim to trigger `/api/verify-claim`.
Two problems:

1. **Friction:** verdicts only appear if the user clicks. Most won't.
2. **Selectivity:** the extractor still surfaces claims that a well-trained model
   would rarely get wrong. The product's value is spotting the *gaps* — claims in
   the thin, stale, or fabricatable regions of training data.

## Goal

One shot: the extension sends an AI response, and within ~3–5 seconds gets back
the risky claims **with verdicts and sources already attached**. Gemini-only.

## Architecture

### The combined check pipeline

`POST /api/fact-check` (auto, every AI response):

1. **Local gate** (existing `lib/fact-check-gate.ts`) — skips tiny/code-only
   responses at zero cost. Unchanged.
2. **One Gemini 2.5 Flash call** with `tools: [{ google_search: {} }]` and
   `thinkingBudget: 0`. The prompt instructs the model to:
   - Select **0–3** claims worth checking (selection bar below).
   - Search the web for each selected claim (few targeted queries, not
     exhaustive research).
   - Return a single JSON payload: per claim — `claim_text`, `anchored_to`,
     `claim_type`, `claim_subtype`, `why_check`, and a `verification` object
     (`verdict`, `evidence`, `source_urls[]`, `as_of_date`, `was_true_until`,
     `follow_up_prompt`) — same field names as the `/api/verify-claim` wire shape.
3. **Persist** — one `response_analyses` row + one `claim_verifications` row per
   verified claim.
4. **Respond** with everything in one payload.

`POST /api/fact-check-selection` gets the identical treatment for a highlighted
slice of text.

`POST /api/verify-claim` is **unchanged**: it remains the manual "re-check this
one claim, dig deeper" path, especially for claims that came back
`unverified`. Its existing quota metering stays as-is.

### Latency budget (target 3–5s, hard cap 10s)

- Single network round trip; Gemini runs its searches internally.
- `thinkingBudget: 0` on the Flash call.
- Max 3 claims; prompt says to search efficiently.
- Hard 10s timeout on the Gemini fetch → clean `skip: true` on timeout.
- `latency_ms` persisted per call (existing column) for p50/p95 monitoring.

## Claim selection bar ("gap-spotting")

Primary filter: **would a well-trained model plausibly get this wrong?**
Extract-and-verify only claims that are at least one of:

- **Too good to be true** — surprising statistics, dramatic effects,
  "X increases Y by 300%".
- **Specific and fabricatable** — citations, papers, court cases, quotes, URLs
  (the classic hallucination zone).
- **Long-tail / niche** — facts about low-coverage topics: small companies,
  local events, recent releases.
- **Time-sensitive** — prices, versions, laws, records, "current" anything,
  where training-data staleness bites.

Never checked: common knowledge, opinions, advice, code, definitions,
hedged statements ("might", "some studies suggest").

Preserved from v2 prompts:

- Precision over recall: 0 claims is a valid, common outcome. Never pad.
- Priority order: citation > statistic > quote > entity > general.
- Two-axis taxonomy: `claim_type` (`factual` | `prescriptive`) ×
  `claim_subtype` (`citation` | `statistic` | `quote` | `entity` | `general`).
- Verdicts: `supported` | `contradicted` | `unverified`,
  defaulting to `unverified`; never assert truth without recent
  supporting sources; `as_of_date` always set; `was_true_until` only when a
  claim was once true and went stale.
- Prompt-injection defense: `<prompt>` / `<response>` / `<history>` blocks are
  data, with zero-width-space terminator neutralization.
- `anchored_to` must be a verbatim substring of the response (≤80-char anchor
  cap per existing parser rules).

## API contract

Response shape for `/api/fact-check` and `/api/fact-check-selection`
(additive over today's shape — extension changes are additive):

```json
{
  "skip": false,
  "analysis_id": "...",
  "claims": [
    {
      "claim_id": "...",
      "claim_index": 0,
      "analysis_id": "...",
      "claim_text": "...",
      "anchored_to": "...",
      "claim_type": "factual",
      "claim_subtype": "citation",
      "why_check": "...",
      "verification": {
        "verdict": "contradicted",
        "evidence": "2-4 sentence explanation of what sources show",
        "source_urls": ["https://..."],
        "as_of_date": "2026-07-15",
        "was_true_until": null,
        "follow_up_prompt": "ready-to-send correction message, or absent"
      }
    }
  ],
  "prompt_version": "v3"
}
```

Skip shape unchanged: `{ "skip": true, "reason": "...", "analysis_id": "..." }`.

## Persistence

- `response_analyses`: one row per check, as today (`analysis_kind: "fact_check"`).
- `claim_verifications`: one row per auto-verified claim, same table
  `/api/verify-claim` writes to, with a new `trigger` column:
  `auto` (combined call) vs `manual` (`/api/verify-claim`). Requires a
  migration adding `trigger` with default `manual` for existing rows.

## Metering

None on the auto path for this MVP. `/api/verify-claim` keeps its existing
quota behavior (metered only on successful, persisted verifications).

## Error handling

- Gemini call fails or times out → `200 { skip: true, reason: "gemini_error" }`.
  No broken half-state in the extension.
- JSON parses but one claim's verification is malformed → drop that claim,
  keep the rest.
- A `supported` / `contradicted` verdict arriving without at
  least one source → downgrade to `unverified` (precision rule).
- Persistence failure after a successful Gemini call → still return results to
  the user; log the failure.

## Deletions / replacements

- `prompts/fact-check-extractor-prompt.ts` and
  `prompts/fact-check-selection-extractor-prompt.ts` are replaced by combined
  check prompts (extract + verify in one).
- `prompts/fact-check-verifier-prompt.ts` survives, used only by
  `/api/verify-claim`.
- `lib/gemini.ts` gains a combined-check wrapper; the extract-only wrapper goes
  away with its callers.

## Testing

- **Unit (vitest, mocked Gemini):** combined-payload parser; verdict
  source-downgrade rule; malformed-claim dropping; timeout → skip path;
  `trigger` value persisted correctly.
- **Smoke (`test-curl.sh`):** fake-citation response → expect
  `contradicted`; common-knowledge-only response → expect `skip`;
  selection-mode check.
- **Live latency check:** run real Gemini calls before merge; confirm p50 in
  the 3–6s band.
