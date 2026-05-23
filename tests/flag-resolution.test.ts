import { describe, expect, it } from "vitest";
import { resolveFlagItems } from "../lib/flag-resolution.js";
import type { Provocation, Validation } from "../types/index.js";

const v1: Validation = {
  problem: "problem one",
  follow_up_prompt: "follow up one",
  lens: "missing_angle",
  anchored_to: "some anchored text that is long enough",
  severity: "high"
};

const s1: Validation = {
  problem: "suppressed problem",
  follow_up_prompt: "suppressed follow up",
  lens: "hidden_assumption",
  anchored_to: "another anchored text that is long enough",
  severity: "low"
};

const p1: Provocation = {
  question: "legacy question",
  lens: "question_mismatch",
  anchored_to: "legacy anchored text that is long enough",
  severity: "medium"
};

describe("resolveFlagItems", () => {
  it("returns empty array when all inputs are empty", () => {
    expect(resolveFlagItems([], [], [])).toEqual([]);
  });

  it("returns validations when only validations are present", () => {
    expect(resolveFlagItems([v1], [], [])).toEqual([v1]);
  });

  it("returns suppressed when only suppressed are present (THE BUG-FIX CASE)", () => {
    // Prior to the fix, validations.length === 0 caused fallback to legacy
    // provocations even when suppressed had content, yielding an empty array
    // and a 400/404 for a v25 extension firing /api/events on a suppressed flag.
    expect(resolveFlagItems([], [s1], [])).toEqual([s1]);
  });

  it("returns validations then suppressed when both are present", () => {
    expect(resolveFlagItems([v1], [s1], [])).toEqual([v1, s1]);
  });

  it("falls back to legacy provocations when both modern columns are empty", () => {
    expect(resolveFlagItems([], [], [p1])).toEqual([p1]);
  });

  it("ignores legacy provocations when validations are present", () => {
    expect(resolveFlagItems([v1], [], [p1])).toEqual([v1]);
  });
});
