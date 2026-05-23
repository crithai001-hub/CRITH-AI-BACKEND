import type { Flag, Lens } from "../types/index.js";

// Frontend's documented priority order (highest first). Mirror it exactly so
// the server's inline pick matches what the extension would have chosen.
export const LENS_PRIORITY: Record<Lens, number> = {
  hallucination: 0,
  sycophancy: 1,
  confidence_evidence_gap: 2,
  hidden_assumption: 3,
  missing_angle: 4,
  question_mismatch: 5
};

// Lenses that only qualify for inline when the user's prompt is long enough.
// Rationale (from frontend brief): on short prompts, an "AI assumed X about
// you" line is noise — the user's short prompt is the reason the AI had to
// assume in the first place.
const PROMPT_LENGTH_GATED_LENSES = new Set<Lens>([
  "hidden_assumption",
  "confidence_evidence_gap"
]);
const PROMPT_LENGTH_MIN_CHARS = 200;

/**
 * Picks the single flag (or none) to render inline on the AI's response.
 *
 * @param flags - Must be in analysis order — i.e. the order the validator
 *   returned them, with inline-tier items before suppressed-tier items. On a
 *   lens-priority tie the earlier flag in this array wins (ES2019+ stable
 *   sort). Re-sorting before calling this changes tie-breaking silently.
 * @param userPromptLength - Length in characters of the user's prompt.
 *   `hidden_assumption` and `confidence_evidence_gap` only qualify when this
 *   is >= 200 (short prompts make assumption-class flags read as noise).
 */
export function pickInlineFlag(flags: readonly Flag[], userPromptLength: number): string | null {
  const highSeverity = flags.filter((f) => f.severity === "high");
  const passesPromptLen = highSeverity.filter((f) => {
    if (PROMPT_LENGTH_GATED_LENSES.has(f.lens)) {
      return userPromptLength >= PROMPT_LENGTH_MIN_CHARS;
    }
    return true;
  });
  if (passesPromptLen.length === 0) return null;

  // Stable sort by lens priority. Array.prototype.sort is stable in ES2019+
  // (V8 and Node 12+), so insertion order is preserved on ties.
  const sorted = [...passesPromptLen].sort(
    (a, b) => LENS_PRIORITY[a.lens] - LENS_PRIORITY[b.lens]
  );
  return sorted[0]!.provocation_id;
}
