# Frontend / extension brief — 2026-05-22

Two backend changes shipped today. One needs frontend work, one is mostly invisible. Locked contracts below; treat them as authoritative.

---

## 1. New `claim_type` value: `actionable_recommendation`

The `claim_type` enum on `VerifiableClaim` grew from 9 to 10 values. Extension MUST handle the new value anywhere it switches on `claim_type` (icons, copy, telemetry, anchor styling).

### What it represents

A specific tool, workflow, command, library, configuration, or step-by-step process the user would need to **go execute or implement**. Examples: "use Postgres", "run `npx supabase init`", "set up a GitHub Actions workflow with this YAML", "configure CORS this way". Vague general advice ("plan carefully", "test your assumptions") still doesn't get flagged.

### Why it matters

The verification step here is **viability**, not fabrication. The tool may exist but not fit the use case; a command may run but produce different output than described; a library may be unmaintained or have a better current alternative. The /api/verify-claim pipeline runs the same as for any other claim, but the framing is "Does this approach work?" rather than "Is this fact real?"

### Backend-guaranteed invariants

1. `claim_type === "actionable_recommendation"` ALWAYS ships with `hallucination_signal: "high"`. The extractor prompt enforces it. Auto-verify therefore fires every time under the existing `high | medium → verify` gate. **Do not add a separate auto-verify branch.**
2. `risk` is typically `"medium"`, occasionally `"high"`. `"low"` is rare but not impossible.
3. `why_verify` is framed as a question — "Does this tool actually support this use case?", "Are there known issues with this approach?". Surface verbatim in the popover.
4. `anchored_to` is still a verbatim 30–80 char substring of the AI response. Same anchor invariant, same underline behavior.
5. Verify response shape `{ verdict, evidence_summary, source_urls, verification_id }` is unchanged.

### Recommended (optional) UX changes

None of these change the wire contract — only the rendering layer.

- **Visual treatment.** Today fabrication-flagged claims share one underline style. A separate treatment for recommendations (e.g., wrench icon, distinct color) helps the user understand "double-check this approach" vs "this might be fake."
- **Verdict copy mapping.** "Confirmed" reads off for a recommendation. Suggested per-type copy:
  - `confirmed` → "Recommendation viable"
  - `contradicted` → "Approach has known issues" / "Better alternatives exist"
  - `inconclusive` → "Couldn't verify viability"
  - `error` → no change
- **Popover header.** "Fact-checked" reads weird here. Consider conditional header text.
- **Telemetry.** Split `actionable_recommendation` out in event payloads so its hit rate, click-through, and useful/not-useful rates can be measured separately.

### Must NOT change

- The auto-verify gate (`hallucination_signal ∈ {high, medium}` → fire). It already covers actionable_recommendation correctly.
- The verify request body shape `{ analysis_id, claim_index }`.
- Treatment of unknown future `claim_type` values: keep a generic fallback. More types may appear without notice.

---

## 2. Search backend: Brave → Gemini google_search grounding

`/api/verify-claim` now calls Gemini 2.5 Flash with the `google_search` tool enabled instead of Brave Search. **Request and response shapes are identical** — no extension changes required for correctness. Read this section only for the one possible visible difference.

### Visible difference: `source_urls`

`source_urls` in the verify response will be Gemini grounding redirect URLs (host: `vertexaisearch.cloud.google.com`, path: `/grounding-api-redirect/...`) instead of raw publisher URLs (`nytimes.com`, `arxiv.org`, etc.).

- Click-through still works — the redirect resolves to the underlying source.
- If the popover renders a domain badge (e.g., "Source: nytimes.com"), every source will now read "vertexaisearch.cloud.google.com". Two reasonable responses:
  - (a) hide the domain badge until we land a publisher-domain resolver, or
  - (b) follow the redirect client-side to extract the real domain.

Both are optional. The verdict + evidence_summary do not depend on it.

### Other invariants

- Function signature, return shape, types, timeout (8 s), and 5-result cap unchanged.
- Same failure reasons (`no_api_key`, `http_error`, `timeout`, `parse_error`). Error names still say "Brave" internally on the backend; treat as opaque.
- `evidence_summary` should be equivalent or better — Gemini's grounding-aware generation tends to be more focused than raw web snippets.

---

## Versioning note

`CLAIM_EXTRACTOR_VERSION` is still `"v4"` despite the new claim type and the new auto-high rule. If you have any version-pinned contract checks on the extension side, they will not trip — but be aware that the schema-level change is real.

## Out of scope

- Token refresh, quota banners. Unchanged.
- `ai_mistake` visual treatment. Unchanged.
- Per-claim user feedback. Existing `/api/events` flow, unchanged.

## Authoritative spec

- `prompts/claim-extractor-prompt.ts` — claim type enum, hallucination_signal rules, output schema.
- `types/index.ts` — `ClaimType`, `VerifiableClaim`, `Verdict`, `VerifyResponse`.

If any of the locked invariants need to change (claim_type enum semantics, the auto-high rule for `actionable_recommendation`, verify request/response shapes), open a backend issue first — the extension's auto-verify logic depends on them.
