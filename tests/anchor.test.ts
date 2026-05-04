import { describe, expect, it } from "vitest";
import { recoverAnchor, ANCHOR_MIN_LEN } from "../lib/anchor.js";

describe("recoverAnchor", () => {
  it("returns the anchor unchanged when it is already a verbatim substring", () => {
    const response = "The pricing is too aggressive for the audience.";
    const anchor = "pricing is too aggressive for the audience";
    expect(recoverAnchor(anchor, response)).toBe(anchor);
  });

  it("recovers when the model concatenated a heading and a list item", () => {
    // Real Vercel-log failure: model emitted "Founders should: Run ~30–100 ..."
    // but the response has those on separate lines / as a list item.
    const response =
      "Founders should:\n\n- Run ~30–100 sales conversations themselves before hiring an SDR\n- Track conversion at every step";
    const anchor = "Founders should: Run ~30–100 sales conversations themselves";
    const recovered = recoverAnchor(anchor, response);
    expect(recovered).not.toBeNull();
    expect(response.includes(recovered!)).toBe(true);
    expect(recovered!.length).toBeGreaterThanOrEqual(ANCHOR_MIN_LEN);
    expect(recovered).toContain("Run ~30–100 sales conversations themselves");
  });

  it("returns null when commas concatenate items but no individual item is long enough", () => {
    // Real Vercel-log failure: "Discounted pricing, High-touch onboarding, In exchange for".
    // None of the three constituent items is >= 30 chars verbatim in the response, so
    // recovery correctly cannot find a usable substring. Drop is the right outcome here.
    const response =
      "Offer the first 10 customers:\n- Discounted pricing (50% off year one)\n- High-touch onboarding sessions every two weeks\n- In exchange for case studies and quarterly testimonials";
    const anchor = "Discounted pricing, High-touch onboarding, In exchange for";
    expect(recoverAnchor(anchor, response)).toBeNull();
  });

  it("recovers when one of the concatenated list items is long enough", () => {
    // If at least one constituent item meets ANCHOR_MIN_LEN, recovery picks it.
    const response =
      "Three commitments to the first cohort:\n- Discounted pricing (50% off the first year)\n- High-touch onboarding sessions every two weeks during launch\n- Quarterly check-ins with the founding team";
    const anchor =
      "Discounted pricing, High-touch onboarding sessions every two weeks during launch";
    const recovered = recoverAnchor(anchor, response);
    expect(recovered).not.toBeNull();
    expect(response.includes(recovered!)).toBe(true);
    expect(recovered!.length).toBeGreaterThanOrEqual(ANCHOR_MIN_LEN);
    expect(recovered).toContain("High-touch onboarding sessions every two weeks");
  });

  it("recovers a partial substring when only part of the anchor exists verbatim", () => {
    const response =
      "Mid-market deals rarely close with one person. You need to engage four to six stakeholders on every deal.";
    const anchor = "Mid-market deals rarely close with one person. You need to engage";
    const recovered = recoverAnchor(anchor, response);
    expect(recovered).not.toBeNull();
    expect(response.includes(recovered!)).toBe(true);
  });

  it("normalizes en-dash vs hyphen mismatches", () => {
    // Response has en-dash, anchor has plain hyphen
    const response = "Run ~30–100 sales conversations before scaling.";
    const anchor = "Run ~30-100 sales conversations before scaling";
    const recovered = recoverAnchor(anchor, response);
    expect(recovered).not.toBeNull();
    expect(response.includes(recovered!)).toBe(true);
  });

  it("normalizes curly quotes vs straight quotes", () => {
    const response = "The author calls this the \u201Cinitial wedge\u201D, which is debatable.";
    const anchor = "the \"initial wedge\", which is debatable";
    const recovered = recoverAnchor(anchor, response);
    expect(recovered).not.toBeNull();
    expect(response.includes(recovered!)).toBe(true);
  });

  it("normalizes non-breaking space to regular space", () => {
    const response = "This\u00A0is\u00A0a paragraph with non-breaking spaces between words.";
    const anchor = "This is a paragraph with non-breaking spaces";
    const recovered = recoverAnchor(anchor, response);
    expect(recovered).not.toBeNull();
    expect(response.includes(recovered!)).toBe(true);
  });

  it("returns null when no substring of length >= 30 can be recovered", () => {
    const response = "A short response with completely different content.";
    const anchor = "Founders should: Run ~30–100 sales conversations themselves";
    expect(recoverAnchor(anchor, response)).toBeNull();
  });

  it("returns null when the anchor has no overlap with the response at all", () => {
    expect(recoverAnchor("totally unrelated phrase", "different text entirely")).toBeNull();
  });
});
