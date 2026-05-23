import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import { searchClaim } from "../lib/brave-search.js";
import { verifyClaim } from "../lib/verifier.js";
import { supabaseService } from "../lib/supabase.js";
import type { VerifiableClaim, VerifyRequestBody } from "../types/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidBody(raw: unknown): raw is VerifyRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  return (
    typeof b.analysis_id === "string" &&
    UUID_RE.test(b.analysis_id) &&
    typeof b.claim_index === "number" &&
    Number.isInteger(b.claim_index) &&
    b.claim_index >= 0
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "bad_request", message: "POST only" });
    return;
  }

  try {
    if (!isValidBody(req.body)) {
      res.status(400).json({ error: "bad_request", message: "invalid request body" });
      return;
    }
    const body = req.body;

    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // Service-role lookup (bypasses RLS) — verify ownership explicitly.
    const { data: analysis, error: lookupError } = await supabaseService
      .from("response_analyses")
      .select("user_id, verifiable_claims")
      .eq("id", body.analysis_id)
      .maybeSingle();

    if (lookupError) {
      console.error("[verify-claim] lookup failed", lookupError);
      res.status(500).json({ error: "internal" });
      return;
    }
    if (!analysis || analysis.user_id !== user.user_id) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const claims = (analysis.verifiable_claims ?? []) as VerifiableClaim[];
    const claim = claims[body.claim_index];
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Unified quota — verifications count against the same monthly counter as analyses.
    const quota = await incrementResponseAnalysesQuota(user.user_id);
    if (quota.exceeded) {
      res.status(429).json({ error: "quota_exceeded", limit: quota.limit, used: quota.used });
      return;
    }

    const start = Date.now();

    const search = await searchClaim(claim.claim);
    if (!search.ok) {
      console.error("[verify-claim] brave search failed", { reason: search.reason });
      res.status(500).json({ error: "internal" });
      return;
    }

    let verifierResult;
    try {
      verifierResult = await verifyClaim(claim.claim, search.results);
    } catch (err) {
      console.error("[verify-claim] haiku error", err);
      res.status(500).json({ error: "internal" });
      return;
    }

    const latency_ms = Date.now() - start;

    if (!verifierResult.ok) {
      console.error("[verify-claim] verifier parse_error");
      res.status(500).json({ error: "internal" });
      return;
    }

    const { result, usage } = verifierResult;

    const { data: insertRow, error: insertError } = await supabaseService
      .from("claim_verifications")
      .insert({
        analysis_id: body.analysis_id,
        claim_index: body.claim_index,
        user_id: user.user_id,
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
      console.error("[verify-claim] insert failed", insertError);
      res.status(500).json({ error: "internal" });
      return;
    }

    res.status(200).json({
      verdict: result.verdict,
      // v25+ alias — new extension reads `evidence`, old extension reads
      // `evidence_summary`. Both populated with the same value.
      evidence: result.evidence_summary,
      evidence_summary: result.evidence_summary,
      source_urls: result.source_urls,
      verification_id: insertRow.id as string
    });
  } catch (err) {
    console.error("[verify-claim] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
