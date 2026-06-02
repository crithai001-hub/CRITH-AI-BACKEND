import { describe, expect, it } from "vitest";
import { parseVerifierResponse } from "../lib/verifier.js";

describe("parseVerifierResponse", () => {
  it("parses a well-formed CONFIRMED verdict", () => {
    const json = JSON.stringify({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com", "https://b.com"],
      follow_up_prompt: "Earlier you said X — can you share the primary source?"
    });
    const out = parseVerifierResponse(json);
    expect(out).toEqual({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com", "https://b.com"],
      follow_up_prompt: "Earlier you said X — can you share the primary source?"
    });
  });

  it("filters non-string source_urls", () => {
    const json = JSON.stringify({
      verdict: "inconclusive",
      evidence_summary: "x",
      source_urls: ["https://a.com", 42, null, "https://b.com"],
      follow_up_prompt: "You claimed X — can you cite the study?"
    });
    const out = parseVerifierResponse(json);
    expect(out!.source_urls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("rejects unknown verdict", () => {
    const json = JSON.stringify({
      verdict: "maybe",
      evidence_summary: "x",
      source_urls: [],
      follow_up_prompt: "test"
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseVerifierResponse("not json")).toBeNull();
  });

  it("returns null when follow_up_prompt is missing", () => {
    const json = JSON.stringify({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com"]
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("returns null when follow_up_prompt is empty after trim", () => {
    const json = JSON.stringify({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com"],
      follow_up_prompt: "   "
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("truncates follow_up_prompt longer than 450 chars", () => {
    const longPrompt = "A".repeat(500);
    const json = JSON.stringify({
      verdict: "inconclusive",
      evidence_summary: "x",
      source_urls: [],
      follow_up_prompt: longPrompt
    });
    const out = parseVerifierResponse(json);
    expect(out!.follow_up_prompt).toHaveLength(450);
  });
});
