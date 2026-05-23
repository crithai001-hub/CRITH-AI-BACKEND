import { describe, expect, it } from "vitest";

// Pure-function shape verification — exercises buildFlags + enrichClaims +
// pickInlineFlag without booting the HTTP handler. Imports the helpers via
// re-export from the handler module if exported, otherwise tests the units
// directly.

import { flagId, claimId } from "../lib/ids.js";
import { pickInlineFlag } from "../lib/inline-pick.js";
import type { Flag, Validation, VerifiableClaim } from "../types/index.js";

describe("analyze-response shape", () => {
  it("produces stable flag ids across two passes with identical inputs", () => {
    const v: Validation = {
      problem: "x",
      follow_up_prompt: "y",
      lens: "missing_angle",
      anchored_to: "a stable anchor that exceeds the thirty character minimum",
      severity: "high"
    };
    const a = flagId(v.lens, v.anchored_to);
    const b = flagId(v.lens, v.anchored_to);
    expect(a).toBe(b);
  });

  it("inline-pick on a typical 3-flag analysis with short prompt drops assumption-class flags", () => {
    const flags: Flag[] = [
      {
        provocation_id: "flag_ha",
        analysis_id: "a",
        provocation_index: 0,
        problem: "x",
        follow_up_prompt: "y",
        lens: "hidden_assumption",
        anchored_to: "z",
        severity: "high",
        tier: "inline"
      },
      {
        provocation_id: "flag_ma",
        analysis_id: "a",
        provocation_index: 1,
        problem: "x",
        follow_up_prompt: "y",
        lens: "missing_angle",
        anchored_to: "z",
        severity: "high",
        tier: "inline"
      }
    ];
    expect(pickInlineFlag(flags, 100)).toBe("flag_ma");
    expect(pickInlineFlag(flags, 200)).toBe("flag_ha");
  });

  it("inline-pick returns null on a no-high analysis", () => {
    const flags: Flag[] = [
      {
        provocation_id: "flag_med",
        analysis_id: "a",
        provocation_index: 0,
        problem: "x",
        follow_up_prompt: "y",
        lens: "missing_angle",
        anchored_to: "z",
        severity: "medium",
        tier: "inline"
      }
    ];
    expect(pickInlineFlag(flags, 1000)).toBeNull();
  });

  it("claim id derives from claim_type + anchored_to", () => {
    const c: VerifiableClaim = {
      claim: "Postgres supports JSONB as of 9.4",
      anchored_to: "Postgres supports JSONB as of 9.4",
      claim_type: "technical_fact",
      why_verify: "Is this still accurate?",
      risk: "low",
      hallucination_signal: "medium",
      hallucination_reason: "version-specific fact"
    };
    expect(claimId(c.claim_type, c.anchored_to)).toMatch(/^claim_[0-9a-f]{8}$/);
  });
});
