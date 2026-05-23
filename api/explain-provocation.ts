import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import { explainProvocation } from "../lib/explainer.js";
import { supabaseService } from "../lib/supabase.js";
import { EXPLAINER_PROMPT_VERSION } from "../prompts/explainer-system-prompt.js";
import { resolveFlagItems } from "../lib/flag-resolution.js";
import type { ExplainRequestBody, Lens, Provocation, Validation } from "../types/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidBody(raw: unknown): raw is ExplainRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  return (
    typeof b.analysis_id === "string" &&
    UUID_RE.test(b.analysis_id) &&
    typeof b.provocation_index === "number" &&
    Number.isInteger(b.provocation_index) &&
    b.provocation_index >= 0
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

    // Service-role client bypasses RLS, so verify ownership explicitly.
    // v14+: read validations in addition to legacy provocations.
    // v24+: read suppressed_validations so provocation_index resolves correctly
    // against the combined flags[] array built by buildFlags (validations first,
    // suppressed_validations second).
    const { data: analysis, error: lookupError } = await supabaseService
      .from("response_analyses")
      .select("user_id, provocations, validations, suppressed_validations, original_prompt, original_response")
      .eq("id", body.analysis_id)
      .maybeSingle();

    if (lookupError) {
      console.error("[explain-provocation] analysis lookup failed", lookupError);
      res.status(500).json({ error: "internal" });
      return;
    }
    if (!analysis || analysis.user_id !== user.user_id) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Prefer v14+ validations; fall back to legacy provocations. Build the same
    // combined array as buildFlags (validations first, suppressed_validations
    // second) so provocation_index is correctly aligned with the flags[] array.
    const validations = (analysis.validations ?? []) as Validation[];
    const suppressed = (analysis.suppressed_validations ?? []) as Validation[];
    const provocations = (analysis.provocations ?? []) as Provocation[];
    const items = resolveFlagItems(validations, suppressed, provocations);
    const provocation = items[body.provocation_index];
    if (!provocation) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Pre-migration rows have null original_* columns. The explainer needs the
    // full prompt+response to do its job, so treat that as not_found.
    if (!analysis.original_prompt || !analysis.original_response) {
      console.warn("[explain-provocation] analysis missing original_* columns", {
        analysis_id: body.analysis_id
      });
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Quota — same monthly counter as analyses.
    const quota = await incrementResponseAnalysesQuota(user.user_id);
    if (quota.exceeded) {
      res.status(429).json({
        error: "quota_exceeded",
        limit: quota.limit,
        used: quota.used
      });
      return;
    }

    // Normalize the resolved item to the shape explainProvocation expects.
    // Legacy Provocation rows already have `question`; v14+ Validation rows use
    // `follow_up_prompt` (the ready-to-send form of the same concept).
    const normalizedProvocation: Pick<Provocation, "question" | "lens" | "anchored_to"> =
      "question" in provocation
        ? provocation
        : { question: provocation.follow_up_prompt, lens: provocation.lens as Lens, anchored_to: provocation.anchored_to };

    const start = Date.now();
    let result;
    try {
      result = await explainProvocation(
        analysis.original_prompt as string,
        analysis.original_response as string,
        normalizedProvocation
      );
    } catch (err) {
      console.error("[explain-provocation] claude error", err);
      res.status(500).json({ error: "internal" });
      return;
    }
    const latency_ms = Date.now() - start;

    if (!result.ok) {
      console.error("[explain-provocation] empty response from claude");
      res.status(500).json({ error: "internal" });
      return;
    }

    const { error: insertError } = await supabaseService
      .from("provocation_explanations")
      .insert({
        analysis_id: body.analysis_id,
        provocation_index: body.provocation_index,
        user_id: user.user_id,
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        latency_ms,
        prompt_version: EXPLAINER_PROMPT_VERSION
      });

    if (insertError) {
      // Log but still return — the user got their answer. Telemetry loss only.
      console.error("[explain-provocation] log insert failed", insertError);
    }

    res.status(200).json({ explanation: result.explanation });
  } catch (err) {
    console.error("[explain-provocation] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
