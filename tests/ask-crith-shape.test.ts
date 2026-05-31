import { describe, expect, it } from "vitest";
import { buildFlags, enrichClaims, verifyEligible } from "../lib/flag-pipeline.js";
import type { Validation, VerifiableClaim } from "../types/index.js";

// ask-crith reuses the flag-pipeline helpers with the same contract as
// analyze-response. These tests pin the shape so future ask-crith changes
// don't silently diverge.

describe("ask-crith shape (pipeline reuse)", () => {
  it("buildFlags assigns sequential indices and inline-tier first", () => {
    const inline: Validation = {
      problem: "p1",
      follow_up_prompt: "f1",
      lens: "sycophancy",
      anchored_to: "this anchor is at least thirty characters long",
      severity: "high"
    };
    const suppressed: Validation = {
      problem: "p2",
      follow_up_prompt: "f2",
      lens: "missing_angle",
      anchored_to: "another anchor that is also long enough to pass",
      severity: "medium"
    };
    const flags = buildFlags([inline], [suppressed], "an-analysis");
    expect(flags).toHaveLength(2);
    expect(flags[0]!.tier).toBe("inline");
    expect(flags[0]!.provocation_index).toBe(0);
    expect(flags[1]!.tier).toBe("suppressed");
    expect(flags[1]!.provocation_index).toBe(1);
    expect(flags[0]!.analysis_id).toBe("an-analysis");
  });

  it("enrichClaims sets verify=true for high/medium hallucination signals", () => {
    const claims: VerifiableClaim[] = [
      {
        claim: "x",
        anchored_to: "anchor-a-which-is-long-enough-to-store",
        claim_type: "statistic",
        why_verify: "needs check",
        risk: "medium",
        hallucination_signal: "high",
        hallucination_reason: "round number, no source"
      },
      {
        claim: "y",
        anchored_to: "anchor-b-which-is-also-long-enough-yay",
        claim_type: "date",
        why_verify: "needs check",
        risk: "low",
        hallucination_signal: "none",
        hallucination_reason: "widely known"
      }
    ];
    const enriched = enrichClaims(claims, "ask-id-1");
    expect(enriched).toHaveLength(2);
    expect(enriched[0]!.verify).toBe(true);
    expect(enriched[1]!.verify).toBe(false);
    expect(enriched[0]!.claim_text).toBe("x");
    expect(enriched[0]!.claim_index).toBe(0);
    expect(enriched[1]!.claim_index).toBe(1);
  });

  it("verifyEligible matches frontend filter", () => {
    const base: VerifiableClaim = {
      claim: "x",
      anchored_to: "anchor-long-enough-to-pass-the-min-len",
      claim_type: "statistic",
      why_verify: "w",
      risk: "low",
      hallucination_signal: "none",
      hallucination_reason: "r"
    };
    expect(verifyEligible({ ...base, hallucination_signal: "high" })).toBe(true);
    expect(verifyEligible({ ...base, hallucination_signal: "medium" })).toBe(true);
    expect(verifyEligible({ ...base, hallucination_signal: "none" })).toBe(false);
  });
});
