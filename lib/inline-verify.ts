import { searchClaim } from "./brave-search.js";
import { verifyClaim } from "./verifier.js";
import { supabaseService } from "./supabase.js";
import type { Verdict, VerifiableClaim } from "../types/index.js";

export interface InlineVerifyResult {
  verdict: Verdict;
  evidence: string;
  source_urls: string[];
  verification_id: string;
  search_query: string;
  follow_up_prompt: string;
}

/**
 * Orchestrates a full verification cycle for a single claim and persists the
 * result to `claim_verifications`. Returns null on any failure so the caller's
 * Promise.all never rejects. All failure paths are logged with the
 * [ask-crith-inline-verify] prefix.
 */
export async function inlineVerify(
  claim: VerifiableClaim,
  analysisId: string,
  claimIndex: number,
  userId: string
): Promise<InlineVerifyResult | null> {
  const start = Date.now();

  // Step 1 — search.
  let search: Awaited<ReturnType<typeof searchClaim>>;
  try {
    search = await searchClaim(claim.claim);
  } catch (err) {
    console.error("[ask-crith-inline-verify] searchClaim threw", {
      analysisId,
      claimIndex,
      err
    });
    return null;
  }

  if (!search.ok) {
    console.error("[ask-crith-inline-verify] searchClaim failed", {
      analysisId,
      claimIndex,
      reason: search.reason
    });
    return null;
  }

  // Step 2 — verify.
  let verifierResult: Awaited<ReturnType<typeof verifyClaim>>;
  try {
    verifierResult = await verifyClaim(claim.claim, search.results);
  } catch (err) {
    console.error("[ask-crith-inline-verify] verifyClaim threw", {
      analysisId,
      claimIndex,
      err
    });
    return null;
  }

  const latency_ms = Date.now() - start;

  if (!verifierResult.ok) {
    console.error("[ask-crith-inline-verify] verifier parse_error", {
      analysisId,
      claimIndex
    });
    return null;
  }

  const { result, usage } = verifierResult;

  // Step 3 — persist to claim_verifications so /api/verify-claim doesn't need
  // to re-verify if the frontend calls it later.
  const { data: insertRow, error: insertError } = await supabaseService
    .from("claim_verifications")
    .insert({
      analysis_id: analysisId,
      claim_index: claimIndex,
      user_id: userId,
      verdict: result.verdict,
      evidence_summary: result.evidence_summary,
      source_urls: result.source_urls,
      search_tokens_used: search.results.length,
      haiku_tokens_in: usage.tokens_in,
      haiku_tokens_out: usage.tokens_out,
      latency_ms
    })
    .select("id")
    .single();

  if (insertError || !insertRow) {
    console.error("[ask-crith-inline-verify] insert failed", {
      analysisId,
      claimIndex,
      insertError
    });
    return null;
  }

  return {
    verdict: result.verdict,
    evidence: result.evidence_summary,
    source_urls: result.source_urls,
    verification_id: insertRow.id as string,
    search_query: search.search_query,
    follow_up_prompt: result.follow_up_prompt
  };
}
