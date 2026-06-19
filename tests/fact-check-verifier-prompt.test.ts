// tests/fact-check-verifier-prompt.test.ts
import { describe, expect, it } from "vitest";
import {
  FACT_CHECK_VERIFIER_PROMPT,
  buildFactCheckVerifierUserMessage
} from "../prompts/fact-check-verifier-prompt.js";

describe("FACT_CHECK_VERIFIER_PROMPT", () => {
  it("uses the evidence-state verdict enum", () => {
    expect(FACT_CHECK_VERIFIER_PROMPT).toContain('"supported"');
    expect(FACT_CHECK_VERIFIER_PROMPT).toContain('"contradicted"');
    expect(FACT_CHECK_VERIFIER_PROMPT).toContain('"unverified"');
  });
  it("instructs the model on prescriptive substrate handling", () => {
    expect(FACT_CHECK_VERIFIER_PROMPT).toContain("prescriptive");
    expect(FACT_CHECK_VERIFIER_PROMPT).toContain("NEVER judge whether the recommendation");
  });
  it("instructs the model to default to unverified", () => {
    expect(FACT_CHECK_VERIFIER_PROMPT).toContain("Default here when unsure");
  });
});

describe("buildFactCheckVerifierUserMessage", () => {
  it("injects today, claim_type, claim_subtype, and why_check", () => {
    const out = buildFactCheckVerifierUserMessage({
      claim_text: "Sam Altman is the CEO of OpenAI",
      claim_type: "factual",
      claim_subtype: "entity",
      why_check: "Leadership roles change.",
      today: "2026-06-19"
    });
    expect(out).toContain("Today's date: 2026-06-19");
    expect(out).toContain("Sam Altman is the CEO of OpenAI");
    expect(out).toContain("claim_type: factual");
    expect(out).toContain("claim_subtype: entity");
    expect(out).toContain("Leadership roles change.");
  });
  it("falls back to n/a when why_check is missing", () => {
    const out = buildFactCheckVerifierUserMessage({
      claim_text: "x",
      claim_type: "factual",
      claim_subtype: "general",
      today: "2026-06-19"
    });
    expect(out).toContain("(n/a)");
  });
});
