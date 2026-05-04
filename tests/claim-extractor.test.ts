import { describe, expect, it } from "vitest";
import { parseClaimExtractorResponse } from "../lib/claim-extractor.js";

const RESPONSE =
  "According to a 2023 McKinsey study, 73% of enterprise AI projects fail in the first year due to poor data infrastructure. Sam Altman is the CEO of OpenAI.";

describe("parseClaimExtractorResponse", () => {
  it("parses a well-formed response", () => {
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [
        {
          claim: "McKinsey 2023 study reporting 73% AI project failure",
          anchored_to: "73% of enterprise AI projects fail in the first year",
          claim_type: "statistic",
          why_verify: "Specific statistic; AIs frequently fabricate citations.",
          risk: "high"
        }
      ]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result).not.toBeNull();
    expect(result!.skip).toBe(false);
    expect(result!.verifiable_claims).toHaveLength(1);
    expect(result!.verifiable_claims[0].claim_type).toBe("statistic");
  });

  it("drops claims whose anchored_to is not a substring of the response", () => {
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [
        {
          claim: "fake claim",
          anchored_to: "this string does not appear in the response at all",
          claim_type: "statistic",
          why_verify: "test",
          risk: "low"
        }
      ]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.verifiable_claims).toHaveLength(0);
  });

  it("returns skip with empty array", () => {
    const json = JSON.stringify({ skip: true, verifiable_claims: [] });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.skip).toBe(true);
    expect(result!.verifiable_claims).toHaveLength(0);
  });

  it("rejects invalid claim_type", () => {
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [
        {
          claim: "x",
          anchored_to: "Sam Altman is the CEO of OpenAI",
          claim_type: "not_a_real_type",
          why_verify: "x",
          risk: "low"
        }
      ]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.verifiable_claims).toHaveLength(0);
  });

  it("returns null on totally malformed JSON", () => {
    expect(parseClaimExtractorResponse("not json", RESPONSE)).toBeNull();
    expect(parseClaimExtractorResponse(JSON.stringify({}), RESPONSE)).toBeNull();
  });

  it("caps at 3 claims even if model returns more", () => {
    const claim = {
      claim: "x",
      anchored_to: "Sam Altman is the CEO of OpenAI",
      claim_type: "person_or_role",
      why_verify: "x",
      risk: "low"
    };
    const json = JSON.stringify({
      skip: false,
      verifiable_claims: [claim, claim, claim, claim, claim]
    });
    const result = parseClaimExtractorResponse(json, RESPONSE);
    expect(result!.verifiable_claims).toHaveLength(3);
  });
});
