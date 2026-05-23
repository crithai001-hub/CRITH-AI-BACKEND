import { describe, expect, it } from "vitest";
import { pickInlineFlag, LENS_PRIORITY } from "../lib/inline-pick.js";
import type { Flag } from "../types/index.js";

function makeFlag(overrides: Partial<Flag>): Flag {
  return {
    provocation_id: "flag_test0001",
    analysis_id: "a-1",
    provocation_index: 0,
    problem: "x",
    follow_up_prompt: "y",
    lens: "missing_angle",
    anchored_to: "anchor",
    severity: "high",
    tier: "inline",
    ...overrides
  };
}

describe("LENS_PRIORITY", () => {
  it("orders all six lenses from highest to lowest", () => {
    expect(LENS_PRIORITY).toEqual({
      hallucination: 0,
      sycophancy: 1,
      confidence_evidence_gap: 2,
      hidden_assumption: 3,
      missing_angle: 4,
      question_mismatch: 5
    });
  });
});

describe("pickInlineFlag", () => {
  it("returns null when no flags", () => {
    expect(pickInlineFlag([], 1000)).toBeNull();
  });

  it("returns null when no high-severity flags", () => {
    const flags = [makeFlag({ severity: "medium" }), makeFlag({ severity: "low" })];
    expect(pickInlineFlag(flags, 1000)).toBeNull();
  });

  it("picks the single high-severity flag", () => {
    const flag = makeFlag({ provocation_id: "flag_chosen", severity: "high" });
    expect(pickInlineFlag([flag], 1000)).toBe("flag_chosen");
  });

  it("prefers higher-priority lens among high-severity flags", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_qm", lens: "question_mismatch", severity: "high" }),
      makeFlag({ provocation_id: "flag_ma", lens: "missing_angle", severity: "high" }),
      makeFlag({ provocation_id: "flag_ha", lens: "hidden_assumption", severity: "high" })
    ];
    // hidden_assumption beats missing_angle beats question_mismatch.
    // Prompt is long enough (1000 chars) so the prompt-length gate doesn't fire.
    expect(pickInlineFlag(flags, 1000)).toBe("flag_ha");
  });

  it("filters out hidden_assumption when prompt < 200 chars", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_ha", lens: "hidden_assumption", severity: "high" }),
      makeFlag({ provocation_id: "flag_qm", lens: "question_mismatch", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 100)).toBe("flag_qm");
  });

  it("filters out confidence_evidence_gap when prompt < 200 chars", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_ceg", lens: "confidence_evidence_gap", severity: "high" }),
      makeFlag({ provocation_id: "flag_ma", lens: "missing_angle", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 100)).toBe("flag_ma");
  });

  it("keeps hidden_assumption when prompt >= 200 chars (exact boundary)", () => {
    const flags = [makeFlag({ provocation_id: "flag_ha", lens: "hidden_assumption", severity: "high" })];
    expect(pickInlineFlag(flags, 200)).toBe("flag_ha");
  });

  it("returns null when prompt-len gate filters out the only candidate", () => {
    const flags = [makeFlag({ lens: "hidden_assumption", severity: "high" })];
    expect(pickInlineFlag(flags, 50)).toBeNull();
  });

  it("ignores non-high severity even at top of lens priority", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_hallu_med", lens: "hallucination", severity: "medium" }),
      makeFlag({ provocation_id: "flag_qm_high", lens: "question_mismatch", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 1000)).toBe("flag_qm_high");
  });

  it("breaks lens-priority ties by insertion order (first wins)", () => {
    const flags = [
      makeFlag({ provocation_id: "flag_first", lens: "missing_angle", severity: "high" }),
      makeFlag({ provocation_id: "flag_second", lens: "missing_angle", severity: "high" })
    ];
    expect(pickInlineFlag(flags, 1000)).toBe("flag_first");
  });
});
