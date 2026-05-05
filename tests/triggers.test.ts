import { describe, expect, it } from "vitest";
import {
  codeFenceFraction,
  countWords,
  digitFraction,
  evaluateTriggerGate,
  isDeterministicTask,
  isFactualLookup,
  isResponseMathHeavy
} from "../lib/triggers.js";

describe("countWords", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("  one   two\tthree\n\nfour ")).toBe(4);
  });
  it("returns 0 for empty/whitespace input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });
});

describe("codeFenceFraction", () => {
  it("returns 0 when no fences", () => {
    expect(codeFenceFraction("plain text response")).toBe(0);
  });
  it("computes fraction across multiple fences", () => {
    const text = "intro\n```js\ncode here\n```\noutro\n```py\nmore\n```";
    const frac = codeFenceFraction(text);
    expect(frac).toBeGreaterThan(0);
    expect(frac).toBeLessThan(1);
  });
  it("handles a fully-fenced response", () => {
    const text = "```\nx\n```";
    expect(codeFenceFraction(text)).toBe(1);
  });
});

describe("isFactualLookup (tightened)", () => {
  it("matches simple trivia under 8 words with 1 question mark", () => {
    expect(isFactualLookup("what is the capital of France?")).toBe(true);
    expect(isFactualLookup("who is Ada Lovelace?")).toBe(true);
    expect(isFactualLookup("define entropy?")).toBe(true);
  });
  it("rejects strategy questions even with the prefix", () => {
    expect(
      isFactualLookup(
        "what is the best go-to-market strategy for an early-stage B2B SaaS startup?"
      )
    ).toBe(false);
  });
  it("rejects prompts with multiple question marks", () => {
    expect(isFactualLookup("what is X? and what is Y?")).toBe(false);
  });
  it("matches simple arithmetic without the prefix", () => {
    expect(isFactualLookup("2 + 2 = ?")).toBe(true);
    expect(isFactualLookup("100 / 5")).toBe(true);
  });
  it("rejects prompts that hit 8 words", () => {
    expect(isFactualLookup("what is the meaning of life and everything else?")).toBe(false);
  });
  it("rejects prompts without the prefix and not arithmetic", () => {
    expect(isFactualLookup("explain quantum entanglement?")).toBe(false);
  });
});

const LONG_RESPONSE = Array.from({ length: 120 }, () => "word").join(" ");
const SHORT_RESPONSE = "tiny answer here.";

describe("evaluateTriggerGate", () => {
  it("trips trivial when response is under 80 words", () => {
    expect(evaluateTriggerGate("anything", SHORT_RESPONSE)).toEqual({
      skip: true,
      reason: "trivial"
    });
  });
  it("does not trip code when fences are under 85% (mixed code+prose)", () => {
    // Code is ~2000 chars; prose padding is ~600 chars; total ~2600.
    // codeChars/total ≈ 77% → under threshold → not skipped as code.
    const codeBody = "```python\n" + "x".repeat(2000) + "\n```";
    const prose = "word ".repeat(120);
    const wrapper = prose + " " + codeBody + " " + prose;
    expect(evaluateTriggerGate("explain this please", wrapper).skip).toBe(false);
  });
  it("trips code when fences exceed 85% of a long enough response", () => {
    // Fence body is huge; only a few words of prose outside fences.
    // Word count is well over 80 (the fence body itself contributes many tokens),
    // so the trivial gate does not fire first.
    const fence = "```\n" + ("alpha beta gamma delta epsilon zeta eta theta ".repeat(20)) + "\n```";
    const mostlyCode = "ok " + fence;
    expect(evaluateTriggerGate("write me a program that does X please thanks", mostlyCode)).toEqual({
      skip: true,
      reason: "code"
    });
  });
  it("trips factual on trivia prompts with sufficient response length", () => {
    expect(
      evaluateTriggerGate("what is the capital of France?", LONG_RESPONSE)
    ).toEqual({ skip: true, reason: "factual" });
  });
  it("does not skip a real strategy question with a thoughtful response", () => {
    const result = evaluateTriggerGate(
      "what is the best go-to-market strategy for an early-stage B2B SaaS company targeting mid-market customers?",
      LONG_RESPONSE
    );
    expect(result.skip).toBe(false);
  });
  it("word count fires before code threshold", () => {
    const shortFenced = "```\nshort\n```";
    expect(evaluateTriggerGate("anything", shortFenced)).toEqual({
      skip: true,
      reason: "trivial"
    });
  });
  it("hasContext=true bypasses the trivial word-count check", () => {
    // Same input that fires "trivial" without context — with context it falls
    // through to the no-skip path because the conversation already has substance.
    expect(evaluateTriggerGate("anything", SHORT_RESPONSE, true)).toEqual({
      skip: false
    });
  });
  it("hasContext=true still trips code when fences dominate", () => {
    const fence = "```\n" + ("alpha beta gamma delta epsilon zeta eta theta ".repeat(20)) + "\n```";
    const mostlyCode = "ok " + fence;
    expect(
      evaluateTriggerGate("write me a program that does X please thanks", mostlyCode, true)
    ).toEqual({ skip: true, reason: "code" });
  });
  it("hasContext=true still trips factual on trivia prompts", () => {
    // Even with prior turns, a "what is the capital of France?" is still
    // factual — context shouldn't bypass that gate either.
    expect(
      evaluateTriggerGate("what is the capital of France?", LONG_RESPONSE, true)
    ).toEqual({ skip: true, reason: "factual" });
  });

  it("trips deterministic_task on math 'solve' prompts with a long response", () => {
    // Operators (signal 1) + 'solve' verb (signal 2) + numerics (signal 3) → skip.
    expect(
      evaluateTriggerGate("Solve x^2 + 5x + 6 = 0", LONG_RESPONSE)
    ).toEqual({ skip: true, reason: "deterministic_task" });
  });

  it("does NOT skip a strategy question that mentions 'solve' as one keyword", () => {
    // 'solve' appears but no operators, no numerics. 1 signal at most → analyze.
    const result = evaluateTriggerGate(
      "Should I use Newton's method to solve this kind of optimization problem in production?",
      LONG_RESPONSE
    );
    expect(result.skip).toBe(false);
  });
});

describe("digitFraction", () => {
  it("counts digit characters as a fraction of total", () => {
    expect(digitFraction("abc123")).toBeCloseTo(3 / 6);
    expect(digitFraction("no digits here")).toBe(0);
    expect(digitFraction("")).toBe(0);
  });
});

describe("isDeterministicTask", () => {
  const NUMERIC_RESPONSE = "x = -2 or x = -3. The discriminant is 25 - 24 = 1. So x = (-5 ± 1) / 2.";
  const PROSE_RESPONSE = "Word ".repeat(60).trim();

  it("trips on classic math 'solve' prompt + numeric response", () => {
    expect(isDeterministicTask("Solve x^2 + 5x + 6 = 0", NUMERIC_RESPONSE)).toBe(true);
  });

  it("trips on direct arithmetic question", () => {
    expect(isDeterministicTask("What is 14% of 280?", "14% of 280 = 39.2")).toBe(true);
  });

  it("trips on conversion task", () => {
    expect(isDeterministicTask("Convert 100 USD to EUR at today's rate", "100 USD ≈ 92 EUR")).toBe(true);
  });

  it("trips on integral / calculus task", () => {
    expect(
      isDeterministicTask("Integrate x^2 dx from 0 to 3", "= [x^3/3]_0^3 = 9")
    ).toBe(true);
  });

  it("does NOT trip on a strategic question that contains 'solve'", () => {
    expect(
      isDeterministicTask(
        "Should I use Newton's method to solve this kind of optimization problem?",
        PROSE_RESPONSE
      )
    ).toBe(false);
  });

  it("does NOT trip on a vague 'calculate ROI' prompt without operators or numerics", () => {
    expect(
      isDeterministicTask("Calculate the marketing ROI for my campaign", PROSE_RESPONSE)
    ).toBe(false);
  });

  it("does NOT trip on a strategy prompt with no math signals", () => {
    expect(
      isDeterministicTask(
        "What is the best go-to-market strategy for an early-stage B2B SaaS startup?",
        PROSE_RESPONSE
      )
    ).toBe(false);
  });

  it("does NOT trip on a single isolated number in a prose prompt", () => {
    // "I'm 30 years old, should I switch careers?" — '30' is the only digit,
    // no operators, no computational verb. Strategic question, must analyze.
    expect(
      isDeterministicTask(
        "I'm 30 years old and want to know if I should switch careers to data science",
        PROSE_RESPONSE
      )
    ).toBe(false);
  });

  it("trips on a math-heavy response regardless of prompt shape", () => {
    // Even a vague prompt should skip if the AI's response is dominated by
    // equations / arithmetic — there's no reasoning to question.
    const mathResponse =
      "Step 1: x = -2 or x = -3.\nStep 2: y = 5 + 7 = 12.\nStep 3: z = (12 - 4) / 2 = 4.\nFinal answer: x = 4.";
    expect(isDeterministicTask("how do I do this", mathResponse)).toBe(true);
  });
});

describe("isResponseMathHeavy", () => {
  it("trips on 3+ equation patterns in the response", () => {
    const response =
      "x = -2 and x = -3. The check: 25 - 24 = 1. Therefore y = (-5 + 1) / 2.";
    expect(isResponseMathHeavy(response)).toBe(true);
  });

  it("trips on 5+ math unicode symbols", () => {
    const response = "Compute ∑ over the set, then ∫ from a to b. Bounds: ≤ ≥ ± ≈.";
    expect(isResponseMathHeavy(response)).toBe(true);
  });

  it("trips on 5+ digit-op-digit patterns", () => {
    const response =
      "First 2 + 3 = 5, next 8 - 1 = 7, then 7 * 2 = 14, then 14 / 2 = 7, then 7 + 0 = 7.";
    expect(isResponseMathHeavy(response)).toBe(true);
  });

  it("does NOT trip on prose responses with a few percentages", () => {
    const response =
      "Q1 grew 23%, Q2 grew 35%, Q3 grew 41%. The trend is encouraging but it's worth examining whether the underlying drivers are sustainable into Q4.";
    expect(isResponseMathHeavy(response)).toBe(false);
  });

  it("does NOT trip on a normal prose response with one definition equation", () => {
    const response =
      "GDP per capita = nation's GDP / population. This metric is widely used but has known limitations when comparing across very different economies.";
    expect(isResponseMathHeavy(response)).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(isResponseMathHeavy("")).toBe(false);
  });
});
