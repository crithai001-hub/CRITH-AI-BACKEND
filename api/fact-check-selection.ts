// api/fact-check-selection.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { evaluateFactCheckSelectionGate } from "../lib/fact-check-selection-gate.js";
import { factCheckSelectionExtract } from "../lib/gemini.js";
import { supabaseService } from "../lib/supabase.js";
import { FACT_CHECK_SELECTION_EXTRACTOR_VERSION } from "../prompts/fact-check-selection-extractor-prompt.js";
import type {
  Claim,
  FactCheckSelectionRequestBody,
  Platform,
  SkipReason
} from "../types/index.js";

const VALID_PLATFORMS: ReadonlySet<Platform> = new Set([
  "chatgpt",
  "claude",
  "gemini",
  "perplexity",
  "grok",
  "deepseek"
]);

const SELECTION_MIN = 40;
const SELECTION_MAX = 5000;
const CONTEXT_MAX = 200;
const PROMPT_MAX = 2000;

export function isValidFactCheckSelectionBody(
  raw: unknown
): raw is FactCheckSelectionRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  if (
    typeof b.selected_text !== "string" ||
    typeof b.context_before !== "string" ||
    typeof b.context_after !== "string" ||
    typeof b.prompt !== "string" ||
    typeof b.platform !== "string" ||
    !VALID_PLATFORMS.has(b.platform as Platform) ||
    typeof b.conversation_id !== "string" ||
    typeof b.message_id !== "string"
  ) {
    return false;
  }
  if (b.selected_text.length < SELECTION_MIN || b.selected_text.length > SELECTION_MAX) return false;
  if (b.context_before.length > CONTEXT_MAX) return false;
  if (b.context_after.length > CONTEXT_MAX) return false;
  if (b.prompt.length > PROMPT_MAX) return false;
  return true;
}

interface InsertRowInput {
  user_id: string;
  body: FactCheckSelectionRequestBody;
  skipped: boolean;
  skip_reason: SkipReason | null;
  claims: Claim[];
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
}

async function insertSelectionRow(input: InsertRowInput): Promise<string | null> {
  const { data, error } = await supabaseService
    .from("response_analyses")
    .insert({
      user_id: input.user_id,
      platform: input.body.platform,
      conversation_id: input.body.conversation_id,
      message_id: input.body.message_id,
      prompt_length: input.body.prompt.length,
      response_length: input.body.selected_text.length,
      skipped: input.skipped,
      skip_reason: input.skip_reason,
      provocation_count: input.claims.length,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      cached_tokens: 0,
      latency_ms: input.latency_ms,
      prompt_version: FACT_CHECK_SELECTION_EXTRACTOR_VERSION,
      verifiable_claims: input.claims,
      original_prompt: input.body.prompt,
      original_response: input.body.selected_text,
      conversation_history_turn_count: 0,
      conversation_history_chars: 0,
      analysis_kind: "fact_check_selection",
      ask_context_before: input.body.context_before,
      ask_context_after: input.body.context_after
    })
    .select("id")
    .single();
  if (error) {
    console.error("[fact-check-selection] insert failed", error);
    return null;
  }
  return (data?.id as string) ?? null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "bad_request", message: "POST only" });
    return;
  }

  try {
    if (!isValidFactCheckSelectionBody(req.body)) {
      res.status(400).json({ error: "bad_request", message: "invalid request body" });
      return;
    }
    const body = req.body;

    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const gate = evaluateFactCheckSelectionGate(body.selected_text);
    if (gate.skip && gate.reason) {
      const analysisId = await insertSelectionRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: gate.reason,
        claims: [],
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0
      });
      res.status(200).json({ skip: true, reason: gate.reason, analysis_id: analysisId ?? "" });
      return;
    }

    const start = Date.now();
    const result = await factCheckSelectionExtract(
      body.selected_text,
      body.context_before,
      body.context_after,
      body.prompt
    );
    const latency_ms = Date.now() - start;

    if (!result.ok) {
      const reason: SkipReason =
        result.reason === "parse_error" ? "parse_error" : "gemini_error";
      console.error("[fact-check-selection] extractor failed", { reason });
      const analysisId = await insertSelectionRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: reason,
        claims: [],
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        latency_ms
      });
      res.status(200).json({ skip: true, reason, analysis_id: analysisId ?? "" });
      return;
    }

    // Defensive: anchor MUST be in selection. The parser enforces this via
    // recoverAnchor, but the second pass here logs drift if it ever happens.
    const claimsInSelection = result.result.claims.filter((c) => {
      const ok = body.selected_text.includes(c.anchored_to);
      if (!ok) {
        console.warn("[fact-check-selection] dropping claim — anchor outside selection", {
          anchor_preview: c.anchored_to.slice(0, 80)
        });
      }
      return ok;
    });

    if (result.result.skip || claimsInSelection.length === 0) {
      const analysisId = await insertSelectionRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: "extracted_nothing",
        claims: [],
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        latency_ms
      });
      res.status(200).json({
        skip: true,
        reason: "extracted_nothing",
        analysis_id: analysisId ?? ""
      });
      return;
    }

    const analysisId = await insertSelectionRow({
      user_id: user.user_id,
      body,
      skipped: false,
      skip_reason: null,
      claims: [],
      tokens_in: result.usage.tokens_in,
      tokens_out: result.usage.tokens_out,
      latency_ms
    });
    if (!analysisId) {
      res.status(500).json({ error: "internal" });
      return;
    }

    const claims: Claim[] = claimsInSelection.map((c, idx) => ({
      claim_id: `${analysisId}:${idx}`,
      claim_index: idx,
      analysis_id: analysisId,
      claim_text: c.claim_text,
      anchored_to: c.anchored_to,
      claim_type: c.claim_type,
      why_check: c.why_check
    }));

    await supabaseService
      .from("response_analyses")
      .update({ verifiable_claims: claims, provocation_count: claims.length })
      .eq("id", analysisId);

    res.status(200).json({
      skip: false,
      analysis_id: analysisId,
      claims,
      prompt_version: FACT_CHECK_SELECTION_EXTRACTOR_VERSION
    });
  } catch (err) {
    console.error("[fact-check-selection] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
