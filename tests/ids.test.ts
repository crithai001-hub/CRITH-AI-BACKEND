import { describe, expect, it } from "vitest";
import { djb2, flagId, claimId, disambiguate } from "../lib/ids.js";

describe("djb2", () => {
  it("returns deterministic 8-char hex for the same input", () => {
    expect(djb2("hello")).toBe(djb2("hello"));
    expect(djb2("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different hashes for different inputs", () => {
    expect(djb2("hello")).not.toBe(djb2("world"));
  });
});

describe("flagId", () => {
  it("returns the same id for the same lens + anchor", () => {
    const a = flagId("missing_angle", "the user's specific budget constraint of $5000");
    const b = flagId("missing_angle", "the user's specific budget constraint of $5000");
    expect(a).toBe(b);
  });

  it("returns different ids for different lenses on the same anchor", () => {
    const anchor = "the user's specific budget constraint of $5000";
    expect(flagId("missing_angle", anchor)).not.toBe(flagId("hidden_assumption", anchor));
  });

  it("is stable when the anchor extends in a refire", () => {
    const shortAnchor = "the user's specific budget constraint of $5000";
    const longAnchor = shortAnchor + " over the next 12 months";
    expect(flagId("missing_angle", shortAnchor)).toBe(flagId("missing_angle", longAnchor));
  });

  it("returns 'flag_' prefixed string", () => {
    expect(flagId("missing_angle", "x".repeat(60))).toMatch(/^flag_[0-9a-f]{8}$/);
  });
});

describe("claimId", () => {
  it("returns the same id for the same type + anchor", () => {
    const a = claimId("statistic", "73% of teams fail at sales hiring");
    const b = claimId("statistic", "73% of teams fail at sales hiring");
    expect(a).toBe(b);
  });

  it("returns different ids for different types on the same anchor", () => {
    const anchor = "GitHub Actions workflow with this YAML";
    expect(claimId("technical_fact", anchor)).not.toBe(claimId("actionable_recommendation", anchor));
  });

  it("returns 'claim_' prefixed string", () => {
    expect(claimId("statistic", "x".repeat(60))).toMatch(/^claim_[0-9a-f]{8}$/);
  });
});

describe("disambiguate", () => {
  it("returns ids unchanged when no collisions", () => {
    const ids = ["flag_aaaa1111", "flag_bbbb2222", "flag_cccc3333"];
    expect(disambiguate(ids)).toEqual(ids);
  });

  it("suffixes collisions deterministically", () => {
    const ids = ["flag_aaaa1111", "flag_aaaa1111", "flag_bbbb2222", "flag_aaaa1111"];
    expect(disambiguate(ids)).toEqual([
      "flag_aaaa1111",
      "flag_aaaa1111-1",
      "flag_bbbb2222",
      "flag_aaaa1111-2"
    ]);
  });
});
