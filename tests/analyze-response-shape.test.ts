import { describe, expect, it } from "vitest";

// Pure-function shape verification — exercises buildFlags + enrichClaims +
// pickInlineFlag without booting the HTTP handler. Imports the helpers via
// named exports from the handler module.

import { flagId, claimId } from "../lib/ids.js";
import { pickInlineFlag } from "../lib/inline-pick.js";
import { buildFlags, enrichClaims, verifyEligible } from "../lib/flag-pipeline.js";
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

  // ── verifyEligible ─────────────────────────────────────────────────────────

  it("verifyEligible: high and medium signals are eligible; none is not", () => {
    const base: Omit<VerifiableClaim, "hallucination_signal"> = {
      claim: "Some factual claim about things",
      anchored_to: "Some factual claim about things that is long enough",
      claim_type: "technical_fact",
      why_verify: "Check it",
      risk: "low",
      hallucination_reason: "could be wrong"
    };
    expect(verifyEligible({ ...base, hallucination_signal: "high" })).toBe(true);
    expect(verifyEligible({ ...base, hallucination_signal: "medium" })).toBe(true);
    expect(verifyEligible({ ...base, hallucination_signal: "none" })).toBe(false);
  });

  // ── buildFlags ─────────────────────────────────────────────────────────────

  function makeValidation(lens: Validation["lens"], anchor: string): Validation {
    return {
      problem: "A problem statement for the flag",
      follow_up_prompt: "A follow-up prompt for the user",
      lens,
      anchored_to: anchor,
      severity: "high"
    };
  }

  it("buildFlags: inline-tier items come before suppressed-tier items", () => {
    const inline = makeValidation("missing_angle", "inline anchor text that is long enough here");
    const suppressed = makeValidation("hidden_assumption", "suppressed anchor that is long enough");
    const flags = buildFlags([inline], [suppressed], "test-analysis-id");
    expect(flags[0]!.tier).toBe("inline");
    expect(flags[1]!.tier).toBe("suppressed");
  });

  it("buildFlags: provocation_index matches position in the output array (0..N+M-1)", () => {
    const v1 = makeValidation("missing_angle", "first inline anchor text is long enough here");
    const v2 = makeValidation("missing_angle", "second inline anchor text is long enough here");
    const s1 = makeValidation("hidden_assumption", "first suppressed anchor text long enough");
    const flags = buildFlags([v1, v2], [s1], "test-analysis-id");
    expect(flags).toHaveLength(3);
    flags.forEach((f, idx) => {
      expect(f.provocation_index).toBe(idx);
    });
  });

  it("buildFlags: two validations with identical (lens, anchored_to) get disambiguated IDs", () => {
    const anchor = "identical anchor text used for both flags here to test disambiguation";
    const v1 = makeValidation("missing_angle", anchor);
    const v2 = makeValidation("missing_angle", anchor);
    const flags = buildFlags([v1, v2], [], "test-analysis-id");
    expect(flags[0]!.provocation_id).not.toBe(flags[1]!.provocation_id);
    // Second one should be the disambiguated form (suffix -1)
    expect(flags[1]!.provocation_id).toBe(flags[0]!.provocation_id + "-1");
  });

  // ── enrichClaims ───────────────────────────────────────────────────────────

  it("enrichClaims: claim_text mirrors raw claim field, verify follows verifyEligible, claim_index matches position", () => {
    const claims: VerifiableClaim[] = [
      {
        claim: "First claim text here",
        anchored_to: "First claim text here that is long enough for the anchor",
        claim_type: "technical_fact",
        why_verify: "Check it",
        risk: "low",
        hallucination_signal: "high",
        hallucination_reason: "could be hallucinated"
      },
      {
        claim: "Second claim with no signal",
        anchored_to: "Second claim with no signal that is long enough for anchor",
        claim_type: "statistic",
        why_verify: "Check causality",
        risk: "low",
        hallucination_signal: "none",
        hallucination_reason: "seems fine"
      }
    ];
    const enriched = enrichClaims(claims, "test-analysis-id");
    expect(enriched).toHaveLength(2);

    // claim_text mirrors claim
    expect(enriched[0]!.claim_text).toBe(claims[0]!.claim);
    expect(enriched[1]!.claim_text).toBe(claims[1]!.claim);

    // verify follows verifyEligible
    expect(enriched[0]!.verify).toBe(true);   // hallucination_signal: "high"
    expect(enriched[1]!.verify).toBe(false);  // hallucination_signal: "none"

    // claim_index matches array position
    expect(enriched[0]!.claim_index).toBe(0);
    expect(enriched[1]!.claim_index).toBe(1);
  });
});
