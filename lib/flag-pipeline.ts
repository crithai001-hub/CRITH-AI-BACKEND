import { flagId, claimId, disambiguate } from "./ids.js";
import type {
  EnrichedVerifiableClaim,
  Flag,
  Validation,
  VerifiableClaim
} from "../types/index.js";

// Build the flat flags[] array with stable IDs, tier markers, and indices.
// Inline tier first (preserves prior ranking expectations); suppressed second.
export function buildFlags(
  validations: readonly Validation[],
  suppressed: readonly Validation[],
  analysisId: string
): Flag[] {
  const raw: Array<{ v: Validation; tier: "inline" | "suppressed" }> = [
    ...validations.map((v) => ({ v, tier: "inline" as const })),
    ...suppressed.map((v) => ({ v, tier: "suppressed" as const }))
  ];
  const rawIds = raw.map(({ v }) => flagId(v.lens, v.anchored_to));
  const stableIds = disambiguate(rawIds);
  return raw.map(({ v, tier }, idx) => ({
    provocation_id: stableIds[idx]!,
    analysis_id: analysisId,
    provocation_index: idx,
    problem: v.problem,
    follow_up_prompt: v.follow_up_prompt,
    lens: v.lens,
    anchored_to: v.anchored_to,
    severity: v.severity,
    tier
  }));
}

// Server-side verify-gate: hallucination_signal high|medium → verify true.
export function verifyEligible(claim: VerifiableClaim): boolean {
  return claim.hallucination_signal === "high" || claim.hallucination_signal === "medium";
}

export function enrichClaims(
  claims: readonly VerifiableClaim[],
  analysisId: string
): EnrichedVerifiableClaim[] {
  const rawIds = claims.map((c) => claimId(c.claim_type, c.anchored_to));
  const stableIds = disambiguate(rawIds);
  return claims.map((c, idx) => ({
    ...c,
    claim_id: stableIds[idx]!,
    claim_index: idx,
    analysis_id: analysisId,
    claim_text: c.claim,
    verify: verifyEligible(c)
  }));
}
