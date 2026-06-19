// tests/fact-check-verifier-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseVerifierResponse } from "../lib/gemini.js";

describe("parseVerifierResponse", () => {
  it("parses a well-formed supported verdict with null follow_up_prompt", () => {
    const json = JSON.stringify({
      verdict: "supported",
      evidence: "Two recent sources confirm.",
      source_urls: ["https://a.com", "https://b.com"],
      as_of_date: "2026-06-19",
      was_true_until: null,
      follow_up_prompt: null
    });
    expect(parseVerifierResponse(json)).toEqual({
      verdict: "supported",
      evidence: "Two recent sources confirm.",
      source_urls: ["https://a.com", "https://b.com"],
      as_of_date: "2026-06-19"
    });
  });

  it("parses a contradicted verdict with YYYY-MM was_true_until", () => {
    const json = JSON.stringify({
      verdict: "contradicted",
      evidence: "Was correct ~2015 but social media now dominates.",
      source_urls: ["https://x.com"],
      as_of_date: "2026-06-19",
      was_true_until: "2018-12",
      follow_up_prompt: "You said door-to-door is best — that's outdated; can you update?"
    });
    const out = parseVerifierResponse(json);
    expect(out!.verdict).toBe("contradicted");
    expect(out!.was_true_until).toBe("2018-12");
    expect(out!.follow_up_prompt).toContain("outdated");
  });

  it("accepts YYYY-MM-DD was_true_until as well", () => {
    const json = JSON.stringify({
      verdict: "contradicted",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-06-19",
      was_true_until: "2018-12-31",
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)!.was_true_until).toBe("2018-12-31");
  });

  it("rejects an out-of-range YYYY-MM was_true_until", () => {
    const json = JSON.stringify({
      verdict: "contradicted",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-06-19",
      was_true_until: "2020-13",
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("filters non-string source_urls", () => {
    const json = JSON.stringify({
      verdict: "unverified",
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
      verdict: "unverified",
      evidence: "x",
      source_urls: [],
      as_of_date: "yesterday",
      was_true_until: null,
      follow_up_prompt: "x"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("treats missing follow_up_prompt as undefined", () => {
    const json = JSON.stringify({
      verdict: "supported",
      evidence: "x",
      source_urls: ["https://a.com"],
      as_of_date: "2026-06-19"
    });
    expect(parseVerifierResponse(json)!.follow_up_prompt).toBeUndefined();
  });

  it("treats empty follow_up_prompt as undefined", () => {
    const json = JSON.stringify({
      verdict: "supported",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-06-19",
      follow_up_prompt: "   "
    });
    expect(parseVerifierResponse(json)!.follow_up_prompt).toBeUndefined();
  });

  it("truncates follow_up_prompt over 450 chars", () => {
    const json = JSON.stringify({
      verdict: "unverified",
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
      verdict: "supported",
      evidence: "x",
      source_urls: [],
      as_of_date: "2026-00-00",
      was_true_until: null,
      follow_up_prompt: null
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });
});
