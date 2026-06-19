// tests/fact-check-gate.test.ts
import { describe, expect, it } from "vitest";
import { evaluateFactCheckGate } from "../lib/fact-check-gate.js";

const LONG = Array.from({ length: 120 }, () => "word").join(" ");

describe("evaluateFactCheckGate", () => {
  it("skips trivial responses under 80 words", () => {
    expect(evaluateFactCheckGate("anything", "tiny answer.")).toEqual({
      skip: true,
      reason: "trivial"
    });
  });

  it("skips code-dominated responses", () => {
    const fence = "```\n" + ("alpha beta gamma delta epsilon zeta eta theta ".repeat(20)) + "\n```";
    expect(evaluateFactCheckGate("write me code", "ok " + fence)).toEqual({
      skip: true,
      reason: "code"
    });
  });

  it("skips trivia prompts", () => {
    expect(evaluateFactCheckGate("what is the capital of France?", LONG)).toEqual({
      skip: true,
      reason: "factual_lookup"
    });
  });

  it("does not skip strategic prompts with long responses", () => {
    expect(
      evaluateFactCheckGate(
        "what is the best go-to-market strategy for a B2B SaaS startup?",
        LONG
      )
    ).toEqual({ skip: false });
  });

  it("hasContext=true bypasses the trivial check", () => {
    expect(evaluateFactCheckGate("anything", "tiny answer.", true)).toEqual({
      skip: false
    });
  });

  it("hasContext=true does not bypass code", () => {
    const fence = "```\n" + ("a b c d e f g h ".repeat(50)) + "\n```";
    expect(evaluateFactCheckGate("hi", "ok " + fence, true)).toEqual({
      skip: true,
      reason: "code"
    });
  });

  it("hasContext=true does not bypass factual_lookup", () => {
    expect(evaluateFactCheckGate("what is 2+2?", "tiny", true)).toEqual({
      skip: true,
      reason: "factual_lookup"
    });
  });
});
