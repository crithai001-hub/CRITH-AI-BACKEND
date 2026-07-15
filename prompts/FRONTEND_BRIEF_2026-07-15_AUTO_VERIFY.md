# Frontend Brief — Auto-Verify Fact-Check (2026-07-15)

> Paste this whole document to the extension developer/agent. It is the
> complete, authoritative wire contract for the auto-verify backend that
> shipped to `main` on 2026-07-15 (`4cda63e`).

## What changed (one paragraph)

Fact-checking is now **one shot**. `POST /api/fact-check` no longer returns
bare claims for the user to click — every returned claim arrives **already
verified**, with a verdict, evidence, and source URLs embedded. The
click-to-verify step is gone from the golden path. `POST /api/verify-claim`
still exists but is now a *manual "re-check this claim"* action (quota-metered),
mainly useful when an auto verdict came back `unverified`.

## Auth (unchanged)

Every request: `Authorization: Bearer <supabase access token>` +
`Content-Type: application/json`. `401 { "error": "unauthorized" }` on
missing/expired token.

## 1. POST /api/fact-check — auto, on every AI response

### Request

```json
{
  "prompt": "user's message to the AI (1..20000 chars)",
  "response": "the AI's response text (1..60000 chars)",
  "platform": "chatgpt" | "claude" | "gemini" | "perplexity" | "grok" | "deepseek",
  "conversation_id": "string",
  "message_id": "string",
  "conversation_history": [{ "role": "user" | "assistant", "content": "..." }]
}
```

`conversation_history` is optional.

### Success response (claims found) — 200

```json
{
  "skip": false,
  "analysis_id": "uuid",
  "prompt_version": "v3",
  "claims": [
    {
      "claim_id": "<analysis_id>:0",
      "claim_index": 0,
      "analysis_id": "uuid",
      "claim_text": "self-contained restatement of the claim",
      "anchored_to": "verbatim substring of `response`, ≤80 chars",
      "claim_type": "factual" | "prescriptive",
      "claim_subtype": "citation" | "statistic" | "quote" | "entity" | "general",
      "why_check": "one line: what would make this wrong",
      "verification": {
        "verdict": "supported" | "contradicted" | "unverified",
        "evidence": "2-4 sentences on what sources show",
        "source_urls": ["https://..."],
        "as_of_date": "YYYY-MM-DD",
        "was_true_until": "YYYY-MM",
        "follow_up_prompt": "ready-to-send correction message",
        "verification_id": "uuid"
      }
    }
  ]
}
```

Guarantees:
- 0–3 claims, never more.
- `anchored_to` is ALWAYS a verbatim substring of the `response` you sent —
  underline via `response.includes(anchored_to)`; it always matches.
- `verdict` on the auto path is never `"error"`.
- A `supported`/`contradicted` verdict ALWAYS has ≥1 `source_urls` entry
  (backend downgrades to `unverified` otherwise). Max 5 URLs. URLs may be
  `vertexaisearch.cloud.google.com/grounding-api-redirect/...` links — they
  redirect to the real source; render them as normal links (consider showing
  just "Source 1", "Source 2" as link text).
- Optional fields (`was_true_until`, `follow_up_prompt`, `verification_id`)
  are **absent**, not null, when not applicable. `follow_up_prompt` is absent
  when verdict is `supported`. `verification_id` is absent only if persistence
  failed — the verdict is still valid, but manual re-check may 404.

### Skip response — 200 (normal, expected, NOT an error)

```json
{ "skip": true, "reason": "trivial" | "code" | "factual_lookup" | "extracted_nothing" | "parse_error" | "gemini_error", "analysis_id": "uuid-or-empty-string" }
```

Render nothing for any skip. `extracted_nothing` = nothing risky in the
response (the most common outcome by design). `gemini_error`/`parse_error` =
backend problem; still render nothing, never an error state on the auto path.

### Errors

`400 { "error": "bad_request", "message": "..." }`, `401`, `500 { "error": "internal" }`.
Treat all like skip: render nothing, log.

### Latency — IMPORTANT UX CHANGE

- No risky claims (most responses): **~1s**.
- Claims found and verified: **6–12s typical, up to 15s** (real web searches
  run inside the call). The backend aborts at 15s and returns a skip.
- Do NOT block the page or show a spinner for the auto path; results arrive
  when they arrive. A subtle "checking…" indicator is fine. Set your fetch
  timeout to ≥20s.

## 2. POST /api/fact-check-selection — user highlights text

### Request

```json
{
  "selected_text": "highlighted slice (40..5000 chars)",
  "context_before": "≤200 chars before the selection",
  "context_after": "≤200 chars after",
  "prompt": "originating user prompt (≤2000 chars)",
  "platform": "...", "conversation_id": "...", "message_id": "..."
}
```

All fields required; `context_before`, `context_after`, and `prompt` may be
empty strings.

### Response

Identical shape to `/api/fact-check` (same `VerifiedClaim[]`), plus two extra
skip reasons: `selection_too_short`, `selection_pure_syntax`.
`anchored_to` is a verbatim substring of `selected_text`.

Since the user explicitly asked, DO show a loading state here (expect 6–15s),
and on skip show a gentle "nothing checkable in this selection" message.

## 3. POST /api/verify-claim — manual re-check (unchanged shape)

Use for a "Re-check" button on a claim, primarily when the auto verdict is
`unverified`. **Quota-metered** — don't fire automatically.

Request: `{ "analysis_id": "...", "claim_index": 0 }`

Success 200 — same fields as the embedded `verification` object (flat, not
nested), and here `verdict` CAN be `"error"` (render as "couldn't check").
Latency: up to ~30s. Errors: `404 { "error": "not_found" }`,
`429 { "error": "quota_exceeded", "limit": n, "used": n }`, plus the usual.

## Rendering guidance

- `contradicted` → strongest visual (red underline on `anchored_to`); show
  `evidence`, sources, and a one-click "copy follow-up" using `follow_up_prompt`.
- `supported` → subtle/green; evidence + sources on hover/expand.
- `unverified` → neutral/amber "couldn't verify"; offer the manual Re-check
  button. Never phrase as "false".
- `was_true_until` present → show "was true until {value}" staleness badge.
- `as_of_date` → "checked as of {date}" fine print.

## Test checklist (against production)

1. Fake-citation response (e.g. *"According to the 2024 Stanford Zylo Study,
   remote workers are 340% more productive"*) → 1 claim, `contradicted`,
   ≥1 source, arrives in 6–15s.
2. Common-knowledge response ("Paris is the capital of France…") →
   `{ skip: true }` in ~1s, nothing rendered.
3. Code-only response → `{ skip: true, reason: "code" }`.
4. Highlight a factual sentence ≥40 chars → selection flow returns verified
   claims; anchors underline inside the selection.
5. Re-check button on an `unverified` claim → `/api/verify-claim` returns a
   flat verdict; 429 renders a quota message.
6. Expired token → 401 handled silently (re-auth), no user-facing error.
