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

import { isValidBody } from "../api/ask-crith.js";

describe("ask-crith body validation", () => {
  const valid = {
    selected_text: "x".repeat(50) + " ",
    context_before: "before",
    context_after: "after",
    prompt: "what did the AI say",
    platform: "chatgpt" as const,
    conversation_id: "c1",
    message_id: "ask-s1-50-abc"
  };

  it("accepts a well-formed body", () => {
    expect(isValidBody(valid)).toBe(true);
  });

  it("rejects selected_text below the 40-char minimum", () => {
    expect(isValidBody({ ...valid, selected_text: "too short" })).toBe(false);
  });

  it("rejects selected_text above 5000 chars", () => {
    expect(isValidBody({ ...valid, selected_text: "a".repeat(5001) + " " })).toBe(false);
  });

  it("rejects oversized context_before", () => {
    expect(isValidBody({ ...valid, context_before: "x".repeat(201) })).toBe(false);
  });

  it("rejects oversized context_after", () => {
    expect(isValidBody({ ...valid, context_after: "x".repeat(201) })).toBe(false);
  });

  it("rejects oversized prompt", () => {
    expect(isValidBody({ ...valid, prompt: "x".repeat(2001) })).toBe(false);
  });

  it("rejects an unknown platform", () => {
    expect(isValidBody({ ...valid, platform: "bing" })).toBe(false);
  });

  it("rejects missing fields", () => {
    const { selected_text, ...rest } = valid;
    expect(isValidBody(rest)).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(isValidBody(null)).toBe(false);
    expect(isValidBody("string")).toBe(false);
    expect(isValidBody(42)).toBe(false);
  });
});

import { neutralizeTerminators } from "../prompts/ask-crith-validator-prompt.js";

describe("neutralizeTerminators", () => {
  it("passes through text with no terminators unchanged", () => {
    expect(neutralizeTerminators("plain text with no XML tags")).toBe(
      "plain text with no XML tags"
    );
  });

  it("preserves unrelated angle brackets (HTML, code, etc.)", () => {
    const input = "<div>hello</div> and <p>x</p>";
    expect(neutralizeTerminators(input)).toBe(input);
  });

  it("neutralizes </selection>", () => {
    const result = neutralizeTerminators("before </selection> after");
    expect(result).not.toContain("</selection>");
    expect(result).toContain("/selection>"); // the rest is intact
    expect(result.length).toBe("before </selection> after".length + 1); // +1 for ZWS
  });

  it("neutralizes all four terminators", () => {
    const result = neutralizeTerminators(
      "</selection> </context_before> </context_after> </originating_prompt>"
    );
    expect(result).not.toContain("</selection>");
    expect(result).not.toContain("</context_before>");
    expect(result).not.toContain("</context_after>");
    expect(result).not.toContain("</originating_prompt>");
  });

  it("handles case-insensitive terminators", () => {
    const result = neutralizeTerminators("</SELECTION> </Context_Before>");
    expect(result).not.toContain("</SELECTION>");
    expect(result).not.toContain("</Context_Before>");
  });

  it("handles multiple occurrences in one string", () => {
    const result = neutralizeTerminators("</selection> middle </selection>");
    expect(result.match(/<\/selection>/g)).toBe(null);
  });
});
