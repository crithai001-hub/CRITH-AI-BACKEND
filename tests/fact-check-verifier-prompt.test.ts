// tests/fact-check-verifier-prompt.test.ts
import { describe, expect, it } from "vitest";
import { buildFactCheckVerifierPrompt } from "../prompts/fact-check-verifier-prompt.js";

describe("buildFactCheckVerifierPrompt", () => {
  it("includes the citation framing for citation claims", () => {
    expect(buildFactCheckVerifierPrompt("citation")).toContain("EXISTENCE CHECK");
  });
  it("includes the quote framing for quote claims", () => {
    expect(buildFactCheckVerifierPrompt("quote")).toContain("ATTRIBUTION CHECK");
  });
  it("includes the statistic framing for statistic claims", () => {
    expect(buildFactCheckVerifierPrompt("statistic")).toContain("VALUE CHECK");
  });
  it("includes the factual framing for factual claims", () => {
    expect(buildFactCheckVerifierPrompt("factual")).toContain("GENERIC FACT CHECK");
  });
  it("includes the recency rule for every claim type", () => {
    for (const t of ["citation", "quote", "statistic", "factual"] as const) {
      expect(buildFactCheckVerifierPrompt(t)).toContain("Recency matters");
    }
  });
});
