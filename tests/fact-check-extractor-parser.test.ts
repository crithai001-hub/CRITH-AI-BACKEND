// tests/fact-check-extractor-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseExtractorResponse } from "../lib/gemini.js";

const RESPONSE_TEXT =
  "Sam Altman is the CEO of OpenAI. According to a 2023 McKinsey study, 73% of enterprise AI projects fail.";

describe("parseExtractorResponse", () => {
  it("parses skip:true with empty claims", () => {
    const json = JSON.stringify({ skip: true, claims: [] });
    expect(parseExtractorResponse(json, RESPONSE_TEXT)).toEqual({
      skip: true,
      claims: []
    });
  });

  it("parses a well-formed claim", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [
        {
          claim_text: "Sam Altman is the CEO of OpenAI",
          anchored_to: "Sam Altman is the CEO of OpenAI",
          claim_type: "factual",
          why_check: "Leadership roles change since AI training cutoff."
        }
      ]
    });
    const out = parseExtractorResponse(json, RESPONSE_TEXT);
    expect(out).toEqual({
      skip: false,
      claims: [
        {
          claim_text: "Sam Altman is the CEO of OpenAI",
          anchored_to: "Sam Altman is the CEO of OpenAI",
          claim_type: "factual",
          why_check: "Leadership roles change since AI training cutoff."
        }
      ]
    });
  });

  it("drops claims whose anchor is not in the response", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [
        {
          claim_text: "Made up claim",
          anchored_to: "this exact phrase is not in the response",
          claim_type: "factual",
          why_check: "fabricated"
        }
      ]
    });
    const out = parseExtractorResponse(json, RESPONSE_TEXT);
    expect(out!.claims).toEqual([]);
  });

  it("rejects unknown claim_type", () => {
    const json = JSON.stringify({
      skip: false,
      claims: [
        {
          claim_text: "x",
          anchored_to: "Sam Altman is the CEO of OpenAI",
          claim_type: "what",
          why_check: "x"
        }
      ]
    });
    const out = parseExtractorResponse(json, RESPONSE_TEXT);
    expect(out!.claims).toEqual([]);
  });

  it("caps claims at 3", () => {
    const claim = {
      claim_text: "x",
      anchored_to: "Sam Altman is the CEO of OpenAI",
      claim_type: "factual",
      why_check: "x"
    };
    const json = JSON.stringify({
      skip: false,
      claims: [claim, claim, claim, claim, claim]
    });
    const out = parseExtractorResponse(json, RESPONSE_TEXT);
    expect(out!.claims).toHaveLength(3);
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
