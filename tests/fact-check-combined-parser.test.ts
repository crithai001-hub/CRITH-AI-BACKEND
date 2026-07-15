// tests/fact-check-combined-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseCombinedResponse } from "../lib/gemini.js";

// Source text the anchors must be recoverable from (>= 30-char anchors).
const SOURCE =
  "The Zylo 2024 report found that cold outreach conversion rose 340% year over year, " +
  "and the FTC banned all telemarketing in March 2026 according to Smith v. Jones.";

const ANCHOR_A = "cold outreach conversion rose 340% year over year";
const ANCHOR_B = "the FTC banned all telemarketing in March 2026";

function claim(overrides: Record<string, unknown> = {}) {
  return {
    claim_text: "Cold outreach conversion rose 340% YoY per the Zylo 2024 report",
    anchored_to: ANCHOR_A,
    claim_type: "factual",
    claim_subtype: "statistic",
    why_check: "extraordinary growth figure",
    verification: {
      verdict: "contradicted",
      evidence: "No such report exists. Industry sources show flat conversion rates.",
      source_urls: ["https://example.com/industry-report"],
      as_of_date: "2026-07-15",
      was_true_until: null,
      follow_up_prompt: "The Zylo 2024 report doesn't appear to exist. Please cite a verifiable source."
    },
    ...overrides
  };
}

describe("parseCombinedResponse", () => {
  it("parses a valid single-claim payload", () => {
    const raw = JSON.stringify({ skip: false, claims: [claim()] });
    const result = parseCombinedResponse(raw, SOURCE);
    expect(result).not.toBeNull();
    expect(result!.skip).toBe(false);
    expect(result!.claims).toHaveLength(1);
    expect(result!.claims[0]!.verification.verdict).toBe("contradicted");
    expect(result!.claims[0]!.anchored_to).toBe(ANCHOR_A);
  });

  it("returns skip for {skip: true}", () => {
    const result = parseCombinedResponse(JSON.stringify({ skip: true, claims: [] }), SOURCE);
    expect(result).toEqual({ skip: true, claims: [] });
  });

  it("tolerates markdown fences around the JSON", () => {
    const raw = "```json\n" + JSON.stringify({ skip: false, claims: [claim()] }) + "\n```";
    expect(parseCombinedResponse(raw, SOURCE)).not.toBeNull();
  });

  it("returns null for unparseable text", () => {
    expect(parseCombinedResponse("no json here", SOURCE)).toBeNull();
  });

  it("drops a claim whose verification is malformed, keeps the rest", () => {
    const bad = claim({
      anchored_to: ANCHOR_B,
      verification: { verdict: "contradicted" } // missing required fields
    });
    const raw = JSON.stringify({ skip: false, claims: [claim(), bad] });
    const result = parseCombinedResponse(raw, SOURCE);
    expect(result!.claims).toHaveLength(1);
    expect(result!.claims[0]!.anchored_to).toBe(ANCHOR_A);
  });

  it("truncates a >80-char verbatim anchor instead of dropping the claim", () => {
    const longAnchor =
      "The Zylo 2024 report found that cold outreach conversion rose 340% year over year, and";
    const withLongAnchor = claim({ anchored_to: longAnchor });
    const raw = JSON.stringify({ skip: false, claims: [withLongAnchor] });
    const result = parseCombinedResponse(raw, SOURCE);
    expect(result!.claims).toHaveLength(1);
    const anchor = result!.claims[0]!.anchored_to;
    expect(anchor.length).toBeLessThanOrEqual(80);
    expect(SOURCE.includes(anchor)).toBe(true);
  });

  it("downgrades supported/contradicted without sources to unverified", () => {
    const noSources = claim({
      verification: { ...claim().verification, source_urls: [] }
    });
    const raw = JSON.stringify({ skip: false, claims: [noSources] });
    const result = parseCombinedResponse(raw, SOURCE);
    expect(result!.claims[0]!.verification.verdict).toBe("unverified");
  });

  it("backfills empty source_urls from grounding URLs instead of downgrading", () => {
    const noSources = claim({
      verification: { ...claim().verification, source_urls: [] }
    });
    const raw = JSON.stringify({ skip: false, claims: [noSources] });
    const result = parseCombinedResponse(raw, SOURCE, [
      "https://grounding.example.com/a",
      "https://grounding.example.com/b"
    ]);
    expect(result!.claims[0]!.verification.verdict).toBe("contradicted");
    expect(result!.claims[0]!.verification.source_urls).toEqual([
      "https://grounding.example.com/a",
      "https://grounding.example.com/b"
    ]);
  });

  it("filters search-query URLs, then backfills from grounding URLs", () => {
    const searchOnly = claim({
      verification: {
        ...claim().verification,
        source_urls: ["https://www.google.com/search?q=zylo+2024+report"]
      }
    });
    const raw = JSON.stringify({ skip: false, claims: [searchOnly] });
    const result = parseCombinedResponse(raw, SOURCE, ["https://grounding.example.com/a"]);
    expect(result!.claims[0]!.verification.source_urls).toEqual([
      "https://grounding.example.com/a"
    ]);
  });

  it("caps model-provided source_urls at 5", () => {
    const many = claim({
      verification: {
        ...claim().verification,
        source_urls: Array.from({ length: 9 }, (_, i) => `https://example.com/src-${i}`)
      }
    });
    const raw = JSON.stringify({ skip: false, claims: [many] });
    const result = parseCombinedResponse(raw, SOURCE);
    expect(result!.claims[0]!.verification.source_urls).toHaveLength(5);
  });

  it("downgrades when search-query URLs are filtered and no grounding fallback exists", () => {
    const searchOnly = claim({
      verification: {
        ...claim().verification,
        source_urls: ["https://www.google.com/search?q=zylo+2024+report"]
      }
    });
    const raw = JSON.stringify({ skip: false, claims: [searchOnly] });
    const result = parseCombinedResponse(raw, SOURCE);
    expect(result!.claims[0]!.verification.verdict).toBe("unverified");
    expect(result!.claims[0]!.verification.source_urls).toEqual([]);
  });

  it("allows unverified with empty sources", () => {
    const unv = claim({
      verification: {
        verdict: "unverified",
        evidence: "Could not find sufficient sources.",
        source_urls: [],
        as_of_date: "2026-07-15",
        was_true_until: null,
        follow_up_prompt: null
      }
    });
    const result = parseCombinedResponse(JSON.stringify({ skip: false, claims: [unv] }), SOURCE);
    expect(result!.claims[0]!.verification.verdict).toBe("unverified");
  });

  it("rejects claims whose verdict label is invalid", () => {
    const bad = claim({
      verification: { ...claim().verification, verdict: "true" }
    });
    const result = parseCombinedResponse(JSON.stringify({ skip: false, claims: [bad] }), SOURCE);
    expect(result!.claims).toHaveLength(0);
  });

  it("drops claims with invalid as_of_date", () => {
    const bad = claim({
      verification: { ...claim().verification, as_of_date: "2026-13-45" }
    });
    const result = parseCombinedResponse(JSON.stringify({ skip: false, claims: [bad] }), SOURCE);
    expect(result!.claims).toHaveLength(0);
  });

  it("accepts YYYY-MM was_true_until and normalizes null to undefined", () => {
    const stale = claim({
      verification: { ...claim().verification, was_true_until: "2025-11" }
    });
    const result = parseCombinedResponse(JSON.stringify({ skip: false, claims: [stale] }), SOURCE);
    expect(result!.claims[0]!.verification.was_true_until).toBe("2025-11");
    const fresh = parseCombinedResponse(JSON.stringify({ skip: false, claims: [claim()] }), SOURCE);
    expect(fresh!.claims[0]!.verification.was_true_until).toBeUndefined();
  });

  it("drops claims whose anchor is not recoverable from the source", () => {
    const bad = claim({ anchored_to: "this text does not appear anywhere in the source at all" });
    const result = parseCombinedResponse(JSON.stringify({ skip: false, claims: [bad] }), SOURCE);
    expect(result!.claims).toHaveLength(0);
  });

  it("caps at 3 claims", () => {
    const four = [claim(), claim({ anchored_to: ANCHOR_B }), claim(), claim()];
    const result = parseCombinedResponse(JSON.stringify({ skip: false, claims: four }), SOURCE);
    expect(result!.claims.length).toBeLessThanOrEqual(3);
  });
});
