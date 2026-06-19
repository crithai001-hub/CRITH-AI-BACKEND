// tests/fact-check-selection-gate.test.ts
import { describe, expect, it } from "vitest";
import { evaluateFactCheckSelectionGate } from "../lib/fact-check-selection-gate.js";

describe("evaluateFactCheckSelectionGate", () => {
  it("skips bare URLs", () => {
    expect(evaluateFactCheckSelectionGate("https://example.com/very/long/path")).toEqual({
      skip: true,
      reason: "selection_pure_syntax"
    });
  });

  it("skips selections under 40 chars", () => {
    expect(evaluateFactCheckSelectionGate("too short")).toEqual({
      skip: true,
      reason: "selection_too_short"
    });
  });

  it("skips no-whitespace selections", () => {
    expect(
      evaluateFactCheckSelectionGate("ThisHasNoWhitespaceAndIsLongEnoughToPass40Chars")
    ).toEqual({
      skip: true,
      reason: "selection_too_short"
    });
  });

  it("skips code-dominated selections", () => {
    const fence = "```\n" + ("alpha beta gamma delta epsilon zeta eta theta ".repeat(20)) + "\n```";
    expect(evaluateFactCheckSelectionGate("prose " + fence)).toEqual({
      skip: true,
      reason: "selection_pure_syntax"
    });
  });

  it("passes a normal prose selection", () => {
    const text =
      "The CEO of OpenAI is Sam Altman, who co-founded the company in 2015.";
    expect(evaluateFactCheckSelectionGate(text)).toEqual({ skip: false });
  });
});
