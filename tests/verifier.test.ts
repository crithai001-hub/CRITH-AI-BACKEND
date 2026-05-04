import { describe, expect, it } from "vitest";
import { parseVerifierResponse } from "../lib/verifier.js";

describe("parseVerifierResponse", () => {
  it("parses a well-formed CONFIRMED verdict", () => {
    const json = JSON.stringify({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com", "https://b.com"]
    });
    const out = parseVerifierResponse(json);
    expect(out).toEqual({
      verdict: "confirmed",
      evidence_summary: "Two sources confirm.",
      source_urls: ["https://a.com", "https://b.com"]
    });
  });

  it("filters non-string source_urls", () => {
    const json = JSON.stringify({
      verdict: "inconclusive",
      evidence_summary: "x",
      source_urls: ["https://a.com", 42, null, "https://b.com"]
    });
    const out = parseVerifierResponse(json);
    expect(out!.source_urls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("rejects unknown verdict", () => {
    const json = JSON.stringify({
      verdict: "maybe",
      evidence_summary: "x",
      source_urls: []
    });
    expect(parseVerifierResponse(json)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseVerifierResponse("not json")).toBeNull();
  });
});
