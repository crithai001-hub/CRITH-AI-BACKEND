// tests/fact-check-verifier-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseVerifierResponse } from "../lib/gemini.js";

describe("parseVerifierResponse", () => {
  it("parses a well-formed found_supporting verdict", () => {
    const json = JSON.stringify({
      verdict: "found_supporting",
      evidence: "Two recent sources confirm.",
      source_urls: ["https://a.com", "https://b.com"],
      as_of_date: "2026-06-19",
      was_true_until: null,
      follow_up_prompt: "Earlier you said X — can you share the primary source?"
    });
    expect(parseVerifierResponse(json)).toEqual({
      verdict: "found_supporting",
      evidence: "Two recent sources confirm.",
      source_urls: ["https://a.com", "https://b.com"],
      as_of_date: "2026-06-19",
      follow_up_prompt: "Earlier you said X — can you share the primary source?"
    });
  });

  it("parses a found_contradicting verdict with was_true_until", () => {
    const json = JSON.stringify({
      verdict: "found_contradicting",
      evidence: "Was correct ~2015 but social media now dominates.",
      source_urls: ["https://x.com"],
      as_of_date: "2026-06-19",
      was_true_until: "2018-12-31",
      follow_up_prompt: "You said door-to-door is best — that's outdated; can you update?"
    });
    const out = parseVerifierResponse(json);
    expect(out!.verdict).toBe("found_contradicting");
    expect(out!.was_true_until).toBe("2018-12-31");
  });

  it("filters non-string source_urls", () => {
    const json = JSON.stringify({
      verdict: "could_not_verify",
      evidence: "x",
      source_urls: ["https://a.com", 42, null, "https://b.com"],
      as_of_date: "2026-06-19",
      was_true_until: null,
      follow_up_prompt: "Can you cite the study?"
    });
    expect(parseVerifierResponse(json)!.source_urls).toEqual([
      "https://a.com",
      "https://b.com"
    ]);
  });

  it("rejects unknown verdict", () => {
    const json = JSON.stringify({
      verdict: "maybe",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-06-19",
      was_true_until: null,
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("rejects bad as_of_date format", () => {
    const json = JSON.stringify({
      verdict: "could_not_verify",
      evidence: "x",
      source_urls: [],
      as_of_date: "yesterday",
      was_true_until: null,
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("treats missing was_true_until as undefined", () => {
    const json = JSON.stringify({
      verdict: "found_supporting",
      evidence: "x",
      source_urls: ["https://a.com"],
      as_of_date: "2026-06-19",
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)!.was_true_until).toBeUndefined();
  });

  it("treats explicit null was_true_until as undefined", () => {
    const json = JSON.stringify({
      verdict: "found_supporting",
      evidence: "x",
      source_urls: ["https://a.com"],
      as_of_date: "2026-06-19",
      was_true_until: null,
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)!.was_true_until).toBeUndefined();
  });

  it("rejects bad was_true_until format", () => {
    const json = JSON.stringify({
      verdict: "found_contradicting",
      evidence: "x",
      source_urls: ["https://a.com"],
      as_of_date: "2026-06-19",
      was_true_until: "circa 2020",
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("truncates follow_up_prompt over 450 chars", () => {
    const json = JSON.stringify({
      verdict: "could_not_verify",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-06-19",
      was_true_until: null,
      follow_up_prompt: "A".repeat(500)
    });
    expect(parseVerifierResponse(json)!.follow_up_prompt).toHaveLength(450);
  });

  it("returns null on malformed JSON", () => {
    expect(parseVerifierResponse("not json")).toBeNull();
  });

  it("rejects out-of-range as_of_date that passes the regex", () => {
    const json = JSON.stringify({
      verdict: "found_supporting",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-00-00",
      was_true_until: null,
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });
});
