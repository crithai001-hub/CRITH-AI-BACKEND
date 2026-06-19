// api/fact-check.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { evaluateFactCheckGate } from "../lib/fact-check-gate.js";
import { factCheckExtract } from "../lib/gemini.js";
import { supabaseService } from "../lib/supabase.js";
import { validateConversationHistory } from "../lib/validate-history.js";
import { FACT_CHECK_EXTRACTOR_VERSION } from "../prompts/fact-check-extractor-prompt.js";
import type {
  Claim,
  ConversationTurn,
  FactCheckRequestBody,
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

const PROMPT_MAX = 20000;
const RESPONSE_MAX = 60000;

export function isValidFactCheckBody(raw: unknown): raw is FactCheckRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  if (
    typeof b.prompt !== "string" ||
    typeof b.response !== "string" ||
    typeof b.platform !== "string" ||
    !VALID_PLATFORMS.has(b.platform as Platform) ||
    typeof b.conversation_id !== "string" ||
    typeof b.message_id !== "string"
  ) {
    return false;
  }
  if (b.prompt.length === 0 || b.prompt.length > PROMPT_MAX) return false;
  if (b.response.length === 0 || b.response.length > RESPONSE_MAX) return false;

  if (b.conversation_history !== undefined) {
    if (!Array.isArray(b.conversation_history)) return false;
    for (const t of b.conversation_history) {
      if (!t || typeof t !== "object") return false;
      const turn = t as Record<string, unknown>;
      if (turn.role !== "user" && turn.role !== "assistant") return false;
      if (typeof turn.content !== "string") return false;
    }
  }
  return true;
}

interface InsertRowInput {
  user_id: string;
  body: FactCheckRequestBody;
  skipped: boolean;
  skip_reason: SkipReason | null;
  claims: Claim[];
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  history_turn_count: number;
  history_chars: number;
}

async function insertFactCheckRow(input: InsertRowInput): Promise<string | null> {
  const { data, error } = await supabaseService
    .from("response_analyses")
    .insert({
      user_id: input.user_id,
      platform: input.body.platform,
      conversation_id: input.body.conversation_id,
      message_id: input.body.message_id,
      prompt_length: input.body.prompt.length,
      response_length: input.body.response.length,
      skipped: input.skipped,
      skip_reason: input.skip_reason,
      provocation_count: input.claims.length,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      cached_tokens: 0,
      latency_ms: input.latency_ms,
      prompt_version: FACT_CHECK_EXTRACTOR_VERSION,
      verifiable_claims: input.claims,
      original_prompt: input.body.prompt,
      original_response: input.body.response,
      conversation_history_turn_count: input.history_turn_count,
      conversation_history_chars: input.history_chars,
      analysis_kind: "fact_check"
    })
    .select("id")
    .single();
  if (error) {
    console.error("[fact-check] insert failed", error);
    return null;
  }
  return (data?.id as string) ?? null;
}

function buildClaims(
  raw: ReadonlyArray<{
    claim_text: string;
    anchored_to: string;
    claim_type: Claim["claim_type"];
    why_check: string;
  }>,
  analysisId: string
): Claim[] {
  return raw.map((c, idx) => ({
    claim_id: `${analysisId}:${idx}`,
    claim_index: idx,
    analysis_id: analysisId,
    claim_text: c.claim_text,
    anchored_to: c.anchored_to,
    claim_type: c.claim_type,
    why_check: c.why_check
  }));
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "bad_request", message: "POST only" });
    return;
  }

  try {
    if (!isValidFactCheckBody(req.body)) {
      res.status(400).json({ error: "bad_request", message: "invalid request body" });
      return;
    }
    const body = req.body;

    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const cappedHistory = validateConversationHistory(body.conversation_history);
    const hasContext = cappedHistory.cleaned.length > 0;

    const gate = evaluateFactCheckGate(body.prompt, body.response, hasContext);
    if (gate.skip && gate.reason) {
      const analysisId = await insertFactCheckRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: gate.reason,
        claims: [],
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0,
        history_turn_count: cappedHistory.turn_count,
        history_chars: cappedHistory.char_count
      });
      res.status(200).json({ skip: true, reason: gate.reason, analysis_id: analysisId ?? "" });
      return;
    }

    const start = Date.now();
    const result = await factCheckExtract(
      body.prompt,
      body.response,
      cappedHistory.cleaned as ReadonlyArray<ConversationTurn>
    );
    const latency_ms = Date.now() - start;

    if (!result.ok) {
      const reason: SkipReason = result.reason === "parse_error" ? "parse_error" : "gemini_error";
      console.error("[fact-check] extractor failed", { reason });
      const analysisId = await insertFactCheckRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: reason,
        claims: [],
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        latency_ms,
        history_turn_count: cappedHistory.turn_count,
        history_chars: cappedHistory.char_count
      });
      // Extraction errors do NOT cost the user quota.
      res.status(200).json({ skip: true, reason, analysis_id: analysisId ?? "" });
      return;
    }

    if (result.result.skip || result.result.claims.length === 0) {
      const analysisId = await insertFactCheckRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: "extracted_nothing",
        claims: [],
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        latency_ms,
        history_turn_count: cappedHistory.turn_count,
        history_chars: cappedHistory.char_count
      });
      res.status(200).json({
        skip: true,
        reason: "extracted_nothing",
        analysis_id: analysisId ?? ""
      });
      return;
    }

    // Insert with empty placeholder claims, then update with the enriched
    // ones that carry the real analysis_id. We need the row id before we can
    // stamp claim_id / analysis_id onto each claim.
    const analysisId = await insertFactCheckRow({
      user_id: user.user_id,
      body,
      skipped: false,
      skip_reason: null,
      claims: [],
      tokens_in: result.usage.tokens_in,
      tokens_out: result.usage.tokens_out,
      latency_ms,
      history_turn_count: cappedHistory.turn_count,
      history_chars: cappedHistory.char_count
    });
    if (!analysisId) {
      res.status(500).json({ error: "internal" });
      return;
    }

    const claims = buildClaims(result.result.claims, analysisId);
    await supabaseService
      .from("response_analyses")
      .update({ verifiable_claims: claims, provocation_count: claims.length })
      .eq("id", analysisId);

    res.status(200).json({
      skip: false,
      analysis_id: analysisId,
      claims,
      prompt_version: FACT_CHECK_EXTRACTOR_VERSION
    });
  } catch (err) {
    console.error("[fact-check] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
