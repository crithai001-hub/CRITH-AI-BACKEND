import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import { summarizeFlags } from "../lib/summarizer.js";
import { supabaseService } from "../lib/supabase.js";
import { SUMMARY_REPORT_PROMPT_VERSION } from "../prompts/summary-report-prompt.js";
import type { SummarizeFlagsRequestBody, Validation } from "../types/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The report panel now does broader auditing in addition to synthesizing flags,
// so a 1-flag analysis still benefits from a report (the broader-stuff beat
// surfaces things the validator deliberately suppressed). The 0-flag case is
// also valid — the report becomes "AI did well on the ask; here's what else
// you might want to think about." Only skipped analyses have nothing to report.
const MIN_FLAGS_TO_SUMMARIZE = 0;

function isValidBody(raw: unknown): raw is SummarizeFlagsRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  return typeof b.analysis_id === "string" && UUID_RE.test(b.analysis_id);
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

    // Service-role client bypasses RLS; verify ownership explicitly.
    const { data: analysis, error: lookupError } = await supabaseService
      .from("response_analyses")
      .select(
        "user_id, validations, skipped, original_prompt, original_response, summary_report, summary_report_version"
      )
      .eq("id", body.analysis_id)
      .maybeSingle();

    if (lookupError) {
      console.error("[summarize-flags] analysis lookup failed", lookupError);
      res.status(500).json({ error: "internal" });
      return;
    }
    if (!analysis || analysis.user_id !== user.user_id) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Skipped analyses (factual lookups, trivial responses, pure code, etc.) have
    // no reasoning to audit and no broader gaps worth surfacing. Don't burn tokens.
    if (analysis.skipped === true) {
      res.status(400).json({
        error: "not_applicable",
        message: "analysis was skipped; nothing to summarize"
      });
      return;
    }

    const validations = (analysis.validations ?? []) as Validation[];

    if (validations.length < MIN_FLAGS_TO_SUMMARIZE) {
      res.status(400).json({
        error: "not_applicable",
        message: `summary requires at least ${MIN_FLAGS_TO_SUMMARIZE} flags; analysis has ${validations.length}`
      });
      return;
    }

    if (!analysis.original_prompt || !analysis.original_response) {
      console.warn("[summarize-flags] analysis missing original_* columns", {
        analysis_id: body.analysis_id
      });
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Cache hit — return immediately, log telemetry, skip quota.
    if (
      analysis.summary_report &&
      analysis.summary_report_version === SUMMARY_REPORT_PROMPT_VERSION
    ) {
      const { error: cacheLogError } = await supabaseService
        .from("flag_summaries")
        .insert({
          analysis_id: body.analysis_id,
          user_id: user.user_id,
          cache_hit: true,
          prompt_version: SUMMARY_REPORT_PROMPT_VERSION
        });
      if (cacheLogError) {
        console.error("[summarize-flags] cache-hit log insert failed", cacheLogError);
      }
      res.status(200).json({
        summary: analysis.summary_report as string,
        cache_hit: true
      });
      return;
    }

    // Cache miss — quota gate, then generate.
    const quota = await incrementResponseAnalysesQuota(user.user_id);
    if (quota.exceeded) {
      res.status(429).json({
        error: "quota_exceeded",
        limit: quota.limit,
        used: quota.used
      });
      return;
    }

    const start = Date.now();
    let result;
    try {
      result = await summarizeFlags(
        analysis.original_prompt as string,
        analysis.original_response as string,
        validations
      );
    } catch (err) {
      console.error("[summarize-flags] claude error", err);
      res.status(500).json({ error: "internal" });
      return;
    }
    const latency_ms = Date.now() - start;

    if (!result.ok) {
      console.error("[summarize-flags] empty response from claude");
      res.status(500).json({ error: "internal" });
      return;
    }

    // Cache on the row so subsequent expand-clicks are free.
    const { error: cacheError } = await supabaseService
      .from("response_analyses")
      .update({
        summary_report: result.summary,
        summary_report_version: SUMMARY_REPORT_PROMPT_VERSION
      })
      .eq("id", body.analysis_id);
    if (cacheError) {
      console.error("[summarize-flags] cache write failed", cacheError);
      // Non-fatal — the user gets the summary; we just won't reuse it next time.
    }

    const { error: logError } = await supabaseService
      .from("flag_summaries")
      .insert({
        analysis_id: body.analysis_id,
        user_id: user.user_id,
        cache_hit: false,
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        cached_tokens: result.usage.cached_tokens,
        latency_ms,
        prompt_version: SUMMARY_REPORT_PROMPT_VERSION
      });
    if (logError) {
      console.error("[summarize-flags] log insert failed", logError);
    }

    res.status(200).json({ summary: result.summary, cache_hit: false });
  } catch (err) {
    console.error("[summarize-flags] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
