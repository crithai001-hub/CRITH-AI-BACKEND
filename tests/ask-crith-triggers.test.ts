import { describe, expect, it } from "vitest";
import { evaluateAskCrithGate } from "../lib/ask-crith-triggers.js";

describe("ask-crith trigger gate", () => {
  it("skips selections shorter than 40 chars", () => {
    expect(evaluateAskCrithGate("hi there friend")).toEqual({
      skip: true,
      reason: "ask_too_short"
    });
  });

  it("skips selections with no whitespace (even if length passes)", () => {
    const long = "x".repeat(50);
    expect(evaluateAskCrithGate(long)).toEqual({
      skip: true,
      reason: "ask_too_short"
    });
  });

  it("skips a bare URL", () => {
    expect(evaluateAskCrithGate("https://example.com/very/long/path?query=1")).toEqual({
      skip: true,
      reason: "ask_pure_syntax"
    });
  });

  it("skips a code-dominated selection", () => {
    const code = "```js\n" + "const x = 1;\n".repeat(8) + "```";
    expect(evaluateAskCrithGate(code)).toEqual({
      skip: true,
      reason: "ask_pure_syntax"
    });
  });

  it("skips a single-word greeting padded to length", () => {
    // 40+ chars but still just a greeting repeated
    const greeting = "hello hello hello hello hello hello hello";
    expect(evaluateAskCrithGate(greeting)).toEqual({
      skip: true,
      reason: "ask_pure_syntax"
    });
  });

  it("does NOT skip ordinary prose", () => {
    const prose =
      "The model claims that 73% of teams fail because they don't validate assumptions early enough.";
    expect(evaluateAskCrithGate(prose)).toEqual({ skip: false });
  });

  it("does NOT skip prose containing a URL", () => {
    const text =
      "Check the documentation at https://example.com/docs for the full migration guide and notes.";
    expect(evaluateAskCrithGate(text)).toEqual({ skip: false });
  });
});
