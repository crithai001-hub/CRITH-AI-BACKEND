// tests/fact-check-extractor-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseExtractorResponse } from "../lib/gemini.js";

const RESPONSE_TEXT =
  "Sam Altman is the CEO of OpenAI. According to a 2023 McKinsey study, 73% of enterprise AI projects fail.";

const wellFormed = {
  claim_text: "Sam Altman is the CEO of OpenAI",
  anchored_to: "Sam Altman is the CEO of OpenAI",
  claim_type: "factual",
  claim_subtype: "entity",
  why_check: "Leadership roles change since AI training cutoff."
};

describe("parseExtractorResponse", () => {
  it("parses skip:true with empty claims", () => {
    const json = JSON.stringify({ skip: true, claims: [] });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)).toEqual({
      skip: true,
      claims: []
    });
  });

  it("parses a well-formed factual claim", () => {
    const json = JSON.stringify({ skip: false, claims: [wellFormed] });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)).toEqual({
      skip: false,
      claims: [wellFormed]
    });
  });

  it("parses a prescriptive claim with a citation subtype", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [
        {
          claim_text: "73% of enterprise AI projects fail in the first year",
          anchored_to: "73% of enterprise AI projects fail",
          claim_type: "prescriptive",
          claim_subtype: "citation",
          why_check: "Cited as a 2023 McKinsey study; may not exist."
        }
      ]
    });
    const out = parseExtractorResponse(json, RESPONSE_TEXT);
    expect(out!.claims).toHaveLength(1);
    expect(out!.claims[0]!.claim_type).toBe("prescriptive");
    expect(out!.claims[0]!.claim_subtype).toBe("citation");
  });

  it("drops claims whose anchor is not in the source", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [
        {
          claim_text: "Made up",
          anchored_to: "this exact phrase is not in the response",
          claim_type: "factual",
          claim_subtype: "general",
          why_check: "fabricated"
        }
      ]
    });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)!.claims).toEqual([]);
  });

  it("rejects unknown claim_type", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [{ ...wellFormed, claim_type: "what" }]
    });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)!.claims).toEqual([]);
  });

  it("rejects unknown claim_subtype", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [{ ...wellFormed, claim_subtype: "trivia" }]
    });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)!.claims).toEqual([]);
  });

  it("rejects a claim missing claim_subtype", () => {
    const { claim_subtype: _, ...withoutSubtype } = wellFormed;
    const json = JSON.stringify({ skip: false, claims: [withoutSubtype] });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)!.claims).toEqual([]);
  });

  it("caps claims at 3", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [wellFormed, wellFormed, wellFormed, wellFormed, wellFormed]
    });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)!.claims).toHaveLength(3);
  });

  it("treats missing skip with empty claims as extracted_nothing", () => {
    const json = JSON.stringify({ claims: [] });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)).toEqual({
      skip: false,
      claims: []
    });
  });

  it("returns null on malformed JSON", () => {
    expect(parseExtractorResponse("not json", RESPONSE_TEXT)).toBeNull();
  });

  it("tolerates surrounding text via JSON block extraction", () => {
    const json =
      'Sure! Here is the result: ' +
      JSON.stringify({ skip: true, claims: [] }) +
      ' Hope this helps.';
    expect(parseExtractorResponse(json, RESPONSE_TEXT)).toEqual({
      skip: true,
      claims: []
    });
  });
});
