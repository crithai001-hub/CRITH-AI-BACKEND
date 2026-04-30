import { describe, expect, it } from "vitest";
import {
  codeFenceFraction,
  countWords,
  evaluateTriggerGate,
  isFactualLookup
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
});
