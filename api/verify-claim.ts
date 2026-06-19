// api/verify-claim.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { incrementVerificationQuota } from "../lib/quota.js";
import { factCheckVerify } from "../lib/gemini.js";
import { supabaseService } from "../lib/supabase.js";
import type { Claim, VerifyRequestBody } from "../types/index.js";

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

    // Service-role lookup; verify ownership explicitly.
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

    const claims = (analysis.verifiable_claims ?? []) as Claim[];
    const claim = claims[body.claim_index];
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const start = Date.now();
    const verifier = await factCheckVerify(claim.claim_text, claim.claim_type);
    const latency_ms = Date.now() - start;

    if (!verifier.ok) {
      // Verifier errors do NOT charge quota. We eat the cost.
      console.error("[verify-claim] verifier failed", { reason: verifier.reason });
      res.status(500).json({ error: "internal" });
      return;
    }

    const { result, usage } = verifier;

    // Persist BEFORE charging quota. DB-insert failures are our infra problem;
    // the user should not be billed for a verification that does not yield a
    // persisted row they can later reference.
    const { data: insertRow, error: insertError } = await supabaseService
      .from("claim_verifications")
      .insert({
        analysis_id: body.analysis_id,
        claim_index: body.claim_index,
        user_id: user.user_id,
        verdict: result.verdict,
        evidence_summary: result.evidence,
        source_urls: result.source_urls,
        as_of_date: result.as_of_date,
        was_true_until: result.was_true_until ?? null,
        follow_up_prompt: result.follow_up_prompt,
        gemini_tokens_in: usage.tokens_in,
        gemini_tokens_out: usage.tokens_out,
        latency_ms
      })
      .select("id")
      .single();

    if (insertError || !insertRow) {
      console.error("[verify-claim] insert failed", insertError);
      res.status(500).json({ error: "internal" });
      return;
    }

    // Quota counts only on a fully-persisted verification.
    const quota = await incrementVerificationQuota(user.user_id);
    if (quota.exceeded) {
      res.status(429).json({ error: "quota_exceeded", limit: quota.limit, used: quota.used });
      return;
    }

    const responsePayload: Record<string, unknown> = {
      verdict: result.verdict,
      evidence: result.evidence,
      source_urls: result.source_urls,
      as_of_date: result.as_of_date,
      verification_id: insertRow.id as string,
      follow_up_prompt: result.follow_up_prompt
    };
    if (result.was_true_until !== undefined) {
      responsePayload.was_true_until = result.was_true_until;
    }
    res.status(200).json(responsePayload);
  } catch (err) {
    console.error("[verify-claim] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
