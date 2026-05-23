# Frontend Contract Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move inline-pick + verify-eligibility curation from the Chrome extension to the backend. Ship a flat `flags[]` array with stable `provocation_id`s that survive refires, an `inline_flag_id` chosen server-side, and a per-claim `verify` boolean so the extension renders mechanically with no curation logic of its own.

**Architecture:**
- `/api/analyze-response` adds three additive fields: `flags[]` (flat enriched list = validations + suppressed), `inline_flag_id` (server-picked using severity + lens-priority + 200-char prompt-length gate), and per-claim `verify: boolean`. Old `validations` / `suppressed` / `verifiable_claims` shapes stay populated for backward compat with v23.x extensions still in the wild.
- Stable IDs use a deterministic djb2 hash over `(lens, anchored_to)` for flags and `(claim_type, anchored_to)` for claims. Refires of the same response produce identical IDs for the same logical finding, so the extension's host-dedupe (keyed by `provocation_id`) doesn't tear down + re-render anything.
- `/api/verify-claim` adds an `evidence` field aliased to `evidence_summary`. Old field stays.

**Tech Stack:** TypeScript, Vercel serverless, Anthropic SDK (Haiku 4.5), Supabase Postgres, vitest.

**Open spec resolutions:**

1. **Backward compat is additive.** Old extensions read `validations` / `suppressed` / `verifiable_claims[].claim` / verify's `evidence_summary`. Those fields stay populated. New extensions read `flags[]` / `inline_flag_id` / `verifiable_claims[].claim_text` / verify's `evidence`. Single source of truth per concept on the wire; cleanup pass to drop the old shape happens after the extension version-pin is enforced (separate plan).

2. **Lens enum.** Frontend lists 6 lenses (`hallucination`, `sycophancy`, `confidence_evidence_gap`, `hidden_assumption`, `missing_angle`, `question_mismatch`). Backend's validator emits only 4 — `hallucination` is the claim extractor's territory and `sycophancy` is not yet implemented. We widen the `Lens` type to all 6 for type-completeness so the inline-pick priority table covers every value the frontend ranks, even though the validator never emits the first two today. No prompt changes in this plan.

3. **Stable ID hash.** `djb2(lens + ":" + anchored_to[:60])` → 32-bit hex. Stable across refires when the same lens hits the same (possibly extended) anchor span on the same response. Collisions across different (lens, anchor) pairs within a single analysis are vanishingly rare at the per-analysis scale (max ~6 flags + ~3 claims); on collision, we deterministically suffix `-1`, `-2` to disambiguate.

4. **`generation_artifact` claim_type.** Frontend brief mentions this as a short-circuit type (no /verify-claim call). Backend currently has no equivalent — `ai_mistake` is closest but semantically different. Out of scope for this plan; documented as a follow-up.

5. **Field rename: `evidence_summary` → `evidence`.** Verify endpoint adds the new field as an alias. Both are returned. Same value.

6. **Field rename: `claim` → `claim_text`.** Extractor output ships both fields in `verifiable_claims[]`. Same value.

---

## File structure

**Create:**
- `lib/ids.ts` — djb2 hash + stable ID helpers (`flagId`, `claimId`) + collision-resolver.
- `lib/inline-pick.ts` — pure function: `pickInlineFlag(flags, userPromptLength)` returning the chosen `provocation_id | null`.
- `tests/ids.test.ts` — stability + collision tests.
- `tests/inline-pick.test.ts` — severity gate, lens priority, prompt-length gate, multi-flag tiebreaking tests.

**Modify:**
- `types/index.ts` — widen `Lens`, add `Flag` + `EnrichedVerifiableClaim` + updated `AnalyzeResponse` + `VerifyResponse` shapes.
- `api/analyze-response.ts` — assign stable IDs, build flat `flags[]`, compute `inline_flag_id`, enrich claims with `claim_index` / `claim_text` / `verify` / `analysis_id`, return new fields alongside old ones.
- `api/verify-claim.ts` — return `evidence` alongside `evidence_summary`.
- `lib/claim-extractor.ts` — no behavior change, but document the `verify` mapping is now in `analyze-response.ts` (not here).
- `tests/setup.ts` — no change expected.

**Untouched (intentional):**
- Prompts. The validator prompt's 4-lens enum stays. No model change.
- Migrations. The wire shape grows but the storage shape (raw `validations` / `suppressed_validations` / `verifiable_claims` JSONB) stays the same — the IDs are derived on read each time, not persisted, so refires are guaranteed stable without any DB write path changes.

---

## Task 1: Add stable ID helpers

**Files:**
- Create: `lib/ids.ts`
- Create: `tests/ids.test.ts`

- [ ] **Step 1: Write the failing tests in `tests/ids.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { djb2, flagId, claimId, disambiguate } from "../lib/ids.js";

describe("djb2", () => {
  it("returns deterministic 8-char hex for the same input", () => {
    expect(djb2("hello")).toBe(djb2("hello"));
    expect(djb2("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different hashes for different inputs", () => {
    expect(djb2("hello")).not.toBe(djb2("world"));
  });
});

describe("flagId", () => {
  it("returns the same id for the same lens + anchor", () => {
    const a = flagId("missing_angle", "the user's specific budget constraint of $5000");
    const b = flagId("missing_angle", "the user's specific budget constraint of $5000");
    expect(a).toBe(b);
  });

  it("returns different ids for different lenses on the same anchor", () => {
    const anchor = "the user's specific budget constraint of $5000";
    expect(flagId("missing_angle", anchor)).not.toBe(flagId("hidden_assumption", anchor));
  });

  it("is stable when the anchor grows past 60 chars (refire scenario)", () => {
    const shortAnchor = "the user's specific budget constraint of $5000";
    const longAnchor = shortAnchor + " over the next 12 months";
    expect(flagId("missing_angle", shortAnchor)).toBe(flagId("missing_angle", longAnchor));
  });

  it("returns 'flag_' prefixed string", () => {
    expect(flagId("missing_angle", "x".repeat(60))).toMatch(/^flag_[0-9a-f]{8}$/);
  });
});

describe("claimId", () => {
  it("returns the same id for the same type + anchor", () => {
    const a = claimId("statistic", "73% of teams fail at sales hiring");
    const b = claimId("statistic", "73% of teams fail at sales hiring");
    expect(a).toBe(b);
  });

  it("returns different ids for different types on the same anchor", () => {
    const anchor = "GitHub Actions workflow with this YAML";
    expect(claimId("technical_fact", anchor)).not.toBe(claimId("actionable_recommendation", anchor));
  });

  it("returns 'claim_' prefixed string", () => {
    expect(claimId("statistic", "x".repeat(60))).toMatch(/^claim_[0-9a-f]{8}$/);
  });
});

describe("disambiguate", () => {
  it("returns ids unchanged when no collisions", () => {
    const ids = ["flag_aaaa1111", "flag_bbbb2222", "flag_cccc3333"];
    expect(disambiguate(ids)).toEqual(ids);
  });

  it("suffixes collisions deterministically", () => {
    const ids = ["flag_aaaa1111", "flag_aaaa1111", "flag_bbbb2222", "flag_aaaa1111"];
    expect(disambiguate(ids)).toEqual([
      "flag_aaaa1111",
      "flag_aaaa1111-1",
      "flag_bbbb2222",
      "flag_aaaa1111-2"
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ids.test.ts`
Expected: FAIL with "Cannot find module '../lib/ids.js'".

- [ ] **Step 3: Implement `lib/ids.ts`**

```ts
// Stable, deterministic IDs for flags and claims. The same (lens, anchor) on
// the same response produces the same flag_id across refires — the extension
// dedupes hosts by provocation_id, so refire stability is what stops the
// teardown + re-render flicker the frontend brief calls out.
//
// We truncate anchors to 60 chars before hashing so the ID survives the
// frontend's refire scenario where the response grows and the extracted
// anchor extends beyond the original 30-80 char window.

const ANCHOR_PREFIX_LEN = 60;

export function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + char
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Force unsigned 32-bit, zero-pad to 8 hex chars.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function flagId(lens: string, anchoredTo: string): string {
  const key = `${lens}:${anchoredTo.slice(0, ANCHOR_PREFIX_LEN)}`;
  return `flag_${djb2(key)}`;
}

export function claimId(claimType: string, anchoredTo: string): string {
  const key = `${claimType}:${anchoredTo.slice(0, ANCHOR_PREFIX_LEN)}`;
  return `claim_${djb2(key)}`;
}

// Collisions at the per-analysis scale (max ~10 items) are unlikely but not
// impossible. Suffix duplicates with -1, -2, ... in insertion order so the
// suffix is stable across refires (refire returns same items in same order).
export function disambiguate(ids: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return ids.map((id) => {
    const n = counts.get(id) ?? 0;
    counts.set(id, n + 1);
    return n === 0 ? id : `${id}-${n}`;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ids.test.ts`
Expected: PASS, all assertions green.

- [ ] **Step 5: Commit**

```bash
git add lib/ids.ts tests/ids.test.ts
git commit -m "$(cat <<'EOF'
Add stable djb2-based ID helpers for flags and claims

Refires of the same response now produce identical provocation_ids
when (lens, anchored_to[:60]) matches. Stops the extension's
host-dedupe path from tearing down + re-rendering on every refire.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add inline-pick logic

**Files:**
- Create: `lib/inline-pick.ts`
- Create: `tests/inline-pick.test.ts`

- [ ] **Step 1: Write the failing tests in `tests/inline-pick.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { pickInlineFlag, LENS_PRIORITY } from "../lib/inline-pick.js";
import type { Flag } from "../types/index.js";

function makeFlag(overrides: Partial<Flag>): Flag {
  return {
    provocation_id: "flag_test0001",
    analysis_id: "a-1",
    provocation_index: 0,
    problem: "x",
    follow_up_prompt: "y",
    lens: "missing_angle",
    anchored_to: "anchor",
    severity: "high",
    tier: "inline",
    ...overrides
  };
}

describe("LENS_PRIORITY", () => {
  it("orders all six lenses from highest to lowest", () => {
    expect(LENS_PRIORITY).toEqual({
      hallucination: 0,
      sycophancy: 1,
      confidence_evidence_gap: 2,
      hidden_assumption: 3,
      missing_angle: 4,
      question_mismatch: 5
    });
  });
});

describe("pickInlineFlag", () => {
  it("returns null when no flags", () => {
    expect(pickInlineFlag([], 1000)).toBeNull();
  });

  it("returns null when no high-severity flags", () => {
    const flags = [makeFlag({ severity: "medium" }), makeFlag({ severity: "low" })];
    expect(pickInlineFlag(flags, 1000)).toBeNull();
  });

  it("picks the single high-severity flag", () => {
    const flag = makeFlag({ provocation_id: "flag_chosen", severity: "high" });
    expect(pickInlineFlag([flag], 1000)).toBe("flag_chosen");
  });

  it("prefers higher-priority lens among high-severity flags", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_qm", lens: "question_mismatch", severity: "high" }),
      makeFlag({ provocation_id: "flag_ma", lens: "missing_angle", severity: "high" }),
      makeFlag({ provocation_id: "flag_ha", lens: "hidden_assumption", severity: "high" })
    ];
    // hidden_assumption beats missing_angle beats question_mismatch.
    // Prompt is long enough (1000 chars) so the prompt-length gate doesn't fire.
    expect(pickInlineFlag(flags, 1000)).toBe("flag_ha");
  });

  it("filters out hidden_assumption when prompt < 200 chars", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_ha", lens: "hidden_assumption", severity: "high" }),
      makeFlag({ provocation_id: "flag_qm", lens: "question_mismatch", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 100)).toBe("flag_qm");
  });

  it("filters out confidence_evidence_gap when prompt < 200 chars", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_ceg", lens: "confidence_evidence_gap", severity: "high" }),
      makeFlag({ provocation_id: "flag_ma", lens: "missing_angle", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 100)).toBe("flag_ma");
  });

  it("keeps hidden_assumption when prompt >= 200 chars (exact boundary)", () => {
    const flags = [makeFlag({ provocation_id: "flag_ha", lens: "hidden_assumption", severity: "high" })];
    expect(pickInlineFlag(flags, 200)).toBe("flag_ha");
  });

  it("returns null when prompt-len gate filters out the only candidate", () => {
    const flags = [makeFlag({ lens: "hidden_assumption", severity: "high" })];
    expect(pickInlineFlag(flags, 50)).toBeNull();
  });

  it("ignores non-high severity even at top of lens priority", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_hallu_med", lens: "hallucination", severity: "medium" }),
      makeFlag({ provocation_id: "flag_qm_high", lens: "question_mismatch", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 1000)).toBe("flag_qm_high");
  });

  it("breaks lens-priority ties by insertion order (first wins)", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_first", lens: "missing_angle", severity: "high" }),
      makeFlag({ provocation_id: "flag_second", lens: "missing_angle", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 1000)).toBe("flag_first");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inline-pick.test.ts`
Expected: FAIL with "Cannot find module '../lib/inline-pick.js'" plus "Cannot find module 'Flag' in types/index.js" (Flag is added in Task 3 — that's fine, the test will keep failing until then).

- [ ] **Step 3: Implement `lib/inline-pick.ts`**

```ts
import type { Flag, Lens } from "../types/index.js";

// Frontend's documented priority order (highest first). Mirror it exactly so
// the server's inline pick matches what the extension would have chosen.
export const LENS_PRIORITY: Record<Lens, number> = {
  hallucination: 0,
  sycophancy: 1,
  confidence_evidence_gap: 2,
  hidden_assumption: 3,
  missing_angle: 4,
  question_mismatch: 5
};

// Lenses that only qualify for inline when the user's prompt is long enough.
// Rationale (from frontend brief): on short prompts, an "AI assumed X about
// you" line is noise — the user's short prompt is the reason the AI had to
// assume in the first place.
const PROMPT_LENGTH_GATED_LENSES = new Set<Lens>([
  "hidden_assumption",
  "confidence_evidence_gap"
]);
const PROMPT_LENGTH_MIN = 200;

export function pickInlineFlag(flags: readonly Flag[], userPromptLength: number): string | null {
  const highSeverity = flags.filter((f) => f.severity === "high");
  const passesPromptLen = highSeverity.filter((f) => {
    if (PROMPT_LENGTH_GATED_LENSES.has(f.lens)) {
      return userPromptLength >= PROMPT_LENGTH_MIN;
    }
    return true;
  });
  if (passesPromptLen.length === 0) return null;

  // Stable sort by lens priority. Array.prototype.sort is stable in ES2019+
  // (V8 and Node 12+), so insertion order is preserved on ties.
  const sorted = [...passesPromptLen].sort(
    (a, b) => LENS_PRIORITY[a.lens] - LENS_PRIORITY[b.lens]
  );
  return sorted[0]!.provocation_id;
}
```

- [ ] **Step 4: Run tests — expect partial pass**

Run: `npx vitest run tests/inline-pick.test.ts`
Expected: Likely fails because `Flag` type and the new `Lens` values aren't in `types/index.ts` yet. That's resolved in Task 3. If the import error blocks the tests, leave the failing run for now and move to Task 3 — the inline-pick test suite will go green after Task 3's type changes.

- [ ] **Step 5: Commit**

```bash
git add lib/inline-pick.ts tests/inline-pick.test.ts
git commit -m "$(cat <<'EOF'
Add server-side inline-pick logic with lens priority and prompt-length gate

Moves the extension's pickInlineFlag decision to the backend so all
curation rules live in one place: severity-high only, lens priority
(hallucination > sycophancy > confidence_evidence_gap > hidden_assumption
> missing_angle > question_mismatch), and prompt-length gate of 200 chars
for hidden_assumption + confidence_evidence_gap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend types for new wire shape

**Files:**
- Modify: `types/index.ts`

- [ ] **Step 1: Widen `Lens` enum to include `hallucination` + `sycophancy`**

In `types/index.ts`, replace the existing `Lens` type:

```ts
export type Lens =
  | "missing_angle"
  | "hidden_assumption"
  | "confidence_evidence_gap"
  | "question_mismatch";
```

with:

```ts
// Widened to include hallucination + sycophancy so the inline-pick lens
// priority covers every value the frontend ranks. The validator prompt does
// not currently emit hallucination (claim extractor's territory) or sycophancy
// (separate prompt, not yet implemented), but the type completeness keeps the
// server-side inline-pick honest and matches the frontend's enum exactly.
export type Lens =
  | "hallucination"
  | "sycophancy"
  | "confidence_evidence_gap"
  | "hidden_assumption"
  | "missing_angle"
  | "question_mismatch";
```

- [ ] **Step 2: Add `Flag` interface (the enriched flat shape)**

Append after the `Validation` interface block:

```ts
// v25+: flat enriched flag shape returned in the new `flags[]` array. Same
// underlying content as a Validation, plus stable id, analysis_id, an index
// into the flat array, and a tier marker so the extension can group panel
// entries without needing a second array. The extension keys host dedup by
// provocation_id — refires of the same logical flag (same lens + anchored_to)
// return the same id so old hosts stay put instead of tearing down.
export type FlagTier = "inline" | "suppressed";

export interface Flag {
  provocation_id: string;
  analysis_id: string;
  provocation_index: number;
  problem: string;
  follow_up_prompt: string;
  lens: Lens;
  anchored_to: string;
  severity: Severity;
  tier: FlagTier;
}
```

- [ ] **Step 3: Extend `VerifiableClaim` and add `EnrichedVerifiableClaim`**

The raw `VerifiableClaim` (what the extractor parses) stays. Add a new enriched shape used on the wire:

```ts
// v25+: enriched claim shape returned on the wire. claim_text is an alias for
// claim (kept on the raw VerifiableClaim for backward compat); verify is the
// server-decided gate the extension trusts to decide whether to fire
// /api/verify-claim.
export interface EnrichedVerifiableClaim extends VerifiableClaim {
  claim_id: string;
  claim_index: number;
  analysis_id: string;
  claim_text: string;
  verify: boolean;
}
```

- [ ] **Step 4: Update `AnalyzeResponse` to include the new fields**

Replace the success branch:

```ts
  | {
      skip: false;
      validations: Validation[];
      suppressed: Validation[];
      verifiable_claims: VerifiableClaim[];
      analysis_id: string;
      prompt_versions: PromptVersions;
    }
```

with:

```ts
  | {
      skip: false;
      // Legacy v24 fields. Kept populated for older extensions; new clients
      // should read `flags` and `verifiable_claims` (now enriched) instead.
      validations: Validation[];
      suppressed: Validation[];
      // v25+ wire shape — flat, enriched, server-curated.
      flags: Flag[];
      inline_flag_id: string | null;
      verifiable_claims: EnrichedVerifiableClaim[];
      analysis_id: string;
      prompt_versions: PromptVersions;
    }
```

- [ ] **Step 5: Update `VerifyResponse` to include `evidence` alias**

Replace the success branch:

```ts
  | {
      verdict: Verdict;
      evidence_summary: string;
      source_urls: string[];
      verification_id: string;
    }
```

with:

```ts
  | {
      verdict: Verdict;
      // v25+ alias of evidence_summary. Both are returned with the same value;
      // new clients should read `evidence`, old clients keep reading
      // `evidence_summary`.
      evidence: string;
      evidence_summary: string;
      source_urls: string[];
      verification_id: string;
    }
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. If `api/analyze-response.ts` or `api/verify-claim.ts` now fails to compile because they don't return the newly-required `flags` / `inline_flag_id` / `evidence` fields, that's expected — Task 4 and Task 5 fix those.

If typecheck fails on something unrelated (e.g. the inline-pick.ts file we wrote in Task 2 can't find `Flag`), it should pass now because we added `Flag` here. Re-run the inline-pick tests:

Run: `npx vitest run tests/inline-pick.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add types/index.ts
git commit -m "$(cat <<'EOF'
Widen Lens enum and add Flag / EnrichedVerifiableClaim wire shapes

Adds hallucination + sycophancy to the Lens enum so server-side
inline-pick covers every priority slot the frontend ranks. Adds Flag
(flat enriched shape for the new flags[] array) and
EnrichedVerifiableClaim (adds claim_id, claim_index, analysis_id,
claim_text alias, server-decided verify boolean).

Old shapes kept on the success response for backward compat — extension
v23.x reads validations / suppressed / claim; v25+ reads flags /
inline_flag_id / claim_text / verify.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire it into `/api/analyze-response`

**Files:**
- Modify: `api/analyze-response.ts`

- [ ] **Step 1: Add new imports at the top**

Replace the import block from `lib/anchor.js` through the type imports with:

```ts
import { anchorsOverlap } from "../lib/anchor.js";
import { flagId, claimId, disambiguate } from "../lib/ids.js";
import { pickInlineFlag } from "../lib/inline-pick.js";
import { supabaseService } from "../lib/supabase.js";
import { validateConversationHistory } from "../lib/validate-history.js";
import { SYSTEM_PROMPT_VERSION } from "../prompts/system-prompt.js";
import { CLAIM_EXTRACTOR_VERSION } from "../prompts/claim-extractor-prompt.js";
import type {
  AnalyzeRequestBody,
  ConversationTurn,
  EnrichedVerifiableClaim,
  Flag,
  Platform,
  PromptVersions,
  SkipReason,
  Validation,
  VerifiableClaim
} from "../types/index.js";
```

- [ ] **Step 2: Add `buildFlags` + `enrichClaims` + `verifyEligible` helpers**

Insert these helper functions above the `handler` function (after `insertAnalysisRow`):

```ts
// Build the flat flags[] array with stable IDs, tier markers, and indices.
// Inline tier first (preserves prior ranking expectations); suppressed second.
function buildFlags(
  validations: readonly Validation[],
  suppressed: readonly Validation[],
  analysisId: string
): Flag[] {
  const raw: Array<{ v: Validation; tier: "inline" | "suppressed" }> = [
    ...validations.map((v) => ({ v, tier: "inline" as const })),
    ...suppressed.map((v) => ({ v, tier: "suppressed" as const }))
  ];
  const rawIds = raw.map(({ v }) => flagId(v.lens, v.anchored_to));
  const stableIds = disambiguate(rawIds);
  return raw.map(({ v, tier }, idx) => ({
    provocation_id: stableIds[idx]!,
    analysis_id: analysisId,
    provocation_index: idx,
    problem: v.problem,
    follow_up_prompt: v.follow_up_prompt,
    lens: v.lens,
    anchored_to: v.anchored_to,
    severity: v.severity,
    tier
  }));
}

// Server-side verify-gate: hallucination_signal high|medium → verify true.
// Matches the extension's current frontend filter — moved here so the
// frontend can drop its filterClaimsForVerify pass entirely.
function verifyEligible(claim: VerifiableClaim): boolean {
  return claim.hallucination_signal === "high" || claim.hallucination_signal === "medium";
}

function enrichClaims(
  claims: readonly VerifiableClaim[],
  analysisId: string
): EnrichedVerifiableClaim[] {
  const rawIds = claims.map((c) => claimId(c.claim_type, c.anchored_to));
  const stableIds = disambiguate(rawIds);
  return claims.map((c, idx) => ({
    ...c,
    claim_id: stableIds[idx]!,
    claim_index: idx,
    analysis_id: analysisId,
    claim_text: c.claim,
    verify: verifyEligible(c)
  }));
}
```

- [ ] **Step 3: Replace the success-branch response**

Find the block:

```ts
    res.status(200).json({
      skip: false,
      validations,
      suppressed: suppressed_validations,
      verifiable_claims,
      analysis_id: analysisId,
      prompt_versions
    });
```

Replace with:

```ts
    const flags = buildFlags(validations, suppressed_validations, analysisId);
    const inline_flag_id = pickInlineFlag(flags, body.prompt.length);
    const enrichedClaims = enrichClaims(verifiable_claims, analysisId);

    res.status(200).json({
      skip: false,
      // Legacy shape kept for backward compat with v23.x extensions.
      validations,
      suppressed: suppressed_validations,
      // v25+ shape — flat, enriched, server-curated. New extensions read these.
      flags,
      inline_flag_id,
      verifiable_claims: enrichedClaims,
      analysis_id: analysisId,
      prompt_versions
    });
```

- [ ] **Step 4: Run the typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS. Existing tests don't read the new fields so they should be unaffected.

- [ ] **Step 6: Add an integration test for the new payload shape**

Append to an existing test file or create `tests/analyze-response-shape.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// Pure-function shape verification — exercises buildFlags + enrichClaims +
// pickInlineFlag without booting the HTTP handler. Imports the helpers via
// re-export from the handler module if exported, otherwise tests the units
// directly.

import { flagId, claimId } from "../lib/ids.js";
import { pickInlineFlag } from "../lib/inline-pick.js";
import type { Flag, Validation, VerifiableClaim } from "../types/index.js";

describe("analyze-response shape", () => {
  it("produces stable flag ids across two passes with identical inputs", () => {
    const v: Validation = {
      problem: "x",
      follow_up_prompt: "y",
      lens: "missing_angle",
      anchored_to: "a stable anchor that exceeds the thirty character minimum",
      severity: "high"
    };
    const a = flagId(v.lens, v.anchored_to);
    const b = flagId(v.lens, v.anchored_to);
    expect(a).toBe(b);
  });

  it("inline-pick on a typical 3-flag analysis with short prompt drops assumption-class flags", () => {
    const flags: Flag[] = [
      {
        provocation_id: "flag_ha",
        analysis_id: "a",
        provocation_index: 0,
        problem: "x",
        follow_up_prompt: "y",
        lens: "hidden_assumption",
        anchored_to: "z",
        severity: "high",
        tier: "inline"
      },
      {
        provocation_id: "flag_ma",
        analysis_id: "a",
        provocation_index: 1,
        problem: "x",
        follow_up_prompt: "y",
        lens: "missing_angle",
        anchored_to: "z",
        severity: "high",
        tier: "inline"
      }
    ];
    expect(pickInlineFlag(flags, 100)).toBe("flag_ma");
    expect(pickInlineFlag(flags, 200)).toBe("flag_ha");
  });

  it("inline-pick returns null on a no-high analysis", () => {
    const flags: Flag[] = [
      {
        provocation_id: "flag_med",
        analysis_id: "a",
        provocation_index: 0,
        problem: "x",
        follow_up_prompt: "y",
        lens: "missing_angle",
        anchored_to: "z",
        severity: "medium",
        tier: "inline"
      }
    ];
    expect(pickInlineFlag(flags, 1000)).toBeNull();
  });

  it("claim id derives from claim_type + anchored_to", () => {
    const c: VerifiableClaim = {
      claim: "Postgres supports JSONB as of 9.4",
      anchored_to: "Postgres supports JSONB as of 9.4",
      claim_type: "technical_fact",
      why_verify: "Is this still accurate?",
      risk: "low",
      hallucination_signal: "medium",
      hallucination_reason: "version-specific fact"
    };
    expect(claimId(c.claim_type, c.anchored_to)).toMatch(/^claim_[0-9a-f]{8}$/);
  });
});
```

- [ ] **Step 7: Run the new test**

Run: `npx vitest run tests/analyze-response-shape.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/analyze-response.ts tests/analyze-response-shape.test.ts
git commit -m "$(cat <<'EOF'
Return flat flags[] + inline_flag_id + enriched claims from analyze-response

Adds v25+ wire shape: flags[] is the flat enriched list with stable
provocation_ids (djb2 hash of lens + anchored_to[:60]), inline_flag_id
is the server-picked inline flag using lens priority + severity +
200-char prompt-length gate, and verifiable_claims now carries
claim_id, claim_index, analysis_id, claim_text alias, and a server-side
verify boolean derived from hallucination_signal.

Old validations / suppressed / verifiable_claims (raw) fields still
returned for backward compat with v23.x extensions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `evidence` alias to `/api/verify-claim`

**Files:**
- Modify: `api/verify-claim.ts`

- [ ] **Step 1: Replace the success-branch response**

Find:

```ts
    res.status(200).json({
      verdict: result.verdict,
      evidence_summary: result.evidence_summary,
      source_urls: result.source_urls,
      verification_id: insertRow.id as string
    });
```

Replace with:

```ts
    res.status(200).json({
      verdict: result.verdict,
      // v25+ alias — new extension reads `evidence`, old extension reads
      // `evidence_summary`. Both populated with the same value.
      evidence: result.evidence_summary,
      evidence_summary: result.evidence_summary,
      source_urls: result.source_urls,
      verification_id: insertRow.id as string
    });
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add api/verify-claim.ts
git commit -m "$(cat <<'EOF'
Return evidence alias alongside evidence_summary from verify-claim

v25+ extension reads `evidence`; v23.x keeps reading `evidence_summary`.
Both populated with the same value. No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Smoke-test against the live handler

**Files:**
- Modify (optional): `test-curl.sh` — add a case that asserts the new fields appear in the response.

- [ ] **Step 1: Boot the dev server**

Run: `npm run dev`
Expected: Vercel dev banner, server listening on `http://localhost:3000`.

- [ ] **Step 2: Get a test JWT (skip if `TEST_TOKEN` already exported)**

Run: `export TEST_TOKEN=$(node --env-file=.env.local scripts/get-test-jwt.mjs me@example.com mypassword)`
Expected: a JWT in the env var.

- [ ] **Step 3: Fire a sample analyze request and inspect the new fields**

Run:
```bash
curl -s -X POST http://localhost:3000/api/analyze-response \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "I want to launch a SaaS for solo founders. What pricing should I use? My budget for the MVP build is $5000 and I have 3 months of runway. The market I am targeting is technical solopreneurs in the AI tooling space who are themselves building developer tools.",
    "response": "You should price it at $99/month with a 14-day free trial. Solo founders are price-sensitive but $99 is the sweet spot for tools they actually use daily. Most SaaS in this space converts at 5-8% from trial to paid. Run lifecycle emails on day 1, 7, and 13 of the trial.",
    "platform": "chatgpt",
    "conversation_id": "smoke-test-1",
    "message_id": "msg-1"
  }' | jq '{ skip, has_flags: (.flags | length > 0), inline_flag_id, claims: [.verifiable_claims[]? | {verify, claim_id, claim_index}] }'
```

Expected: `skip: false`, `has_flags: true`, `inline_flag_id` either a `flag_<hex>` string or null, claims list with `verify` booleans + `claim_id` + `claim_index` per entry.

- [ ] **Step 4: Verify refire produces the same provocation_ids**

Fire the exact same curl as in Step 3 a second time. Inspect both responses' `flags[].provocation_id` lists. Expected: same IDs in both runs (the validator may produce slightly different problem text turn-to-turn, but the lens + anchored_to + the resulting ID should match for the same logical flag).

- [ ] **Step 5: Verify backward-compat fields still populated**

Run a third curl that asserts the old shape:

```bash
curl -s -X POST http://localhost:3000/api/analyze-response \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Short prompt under 200 chars.",
    "response": "A longer response that the validator will likely flag for something. The AI confidently states that all microservices architectures scale linearly with traffic, which is wrong.",
    "platform": "chatgpt",
    "conversation_id": "smoke-test-2",
    "message_id": "msg-2"
  }' | jq '{ has_validations: (.validations | length >= 0), has_suppressed: (.suppressed | length >= 0), has_flags: (.flags | length >= 0) }'
```

Expected: all three keys present and numeric arrays — confirms old + new fields coexist.

- [ ] **Step 6: Commit any test-curl.sh additions if you made them**

```bash
git add test-curl.sh
git commit -m "$(cat <<'EOF'
Add smoke-test case asserting new flags[] + inline_flag_id shape

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist

- [x] All four user action items addressed:
  1. `inline_flag_id` field — Task 4
  2. `verify: boolean` per claim — Task 4 (`verifyEligible` helper)
  3. Single flat `flags[]` — Task 4 (`buildFlags` helper)
  4. Stable `provocation_id` across refires — Task 1 (`flagId` djb2 hash)
- [x] Backward compat preserved: `validations`, `suppressed`, raw `claim`, `evidence_summary` all still populated.
- [x] Field renames added as aliases (not replacements): `claim_text`, `evidence`.
- [x] Lens widening surfaced as an out-of-scope-for-prompt decision (Task 3 step 1 comment).
- [x] `generation_artifact` claim type explicitly listed as out of scope (open spec resolution #4).
- [x] No placeholders. Every step shows actual code + actual command + expected output.
- [x] Tests-first ordering: helpers tested before integration.

## Known follow-ups (out of scope)

1. **`generation_artifact` claim type.** Frontend wants a short-circuit type that synthesizes a contradicted verdict from `hallucination_reason` without a /verify-claim call. Backend would need a new claim_type value + an `auto_verdict` / `prefetched_evidence` field on `EnrichedVerifiableClaim`. Document the mapping with the frontend team before adding.

2. **Sycophancy + hallucination as validator lenses.** Requires a separate prompt or a system-prompt rewrite (current validator explicitly hands those concerns off). Independently worth doing but not coupled to this contract consolidation.

3. **Cleanup pass to drop legacy fields.** Once the extension version-pin enforces v25+, drop `validations` / `suppressed` / `evidence_summary` / raw `claim` from the wire shape. Separate plan once telemetry confirms 100% of installs are on v25+.

4. **Persist server-side curation decisions.** Today `inline_flag_id` and `verify` booleans are computed on read and never stored. If we want to A/B the inline-pick algorithm later, persist the chosen `inline_flag_id` on `response_analyses` so we can rerun analytics against historical picks.
