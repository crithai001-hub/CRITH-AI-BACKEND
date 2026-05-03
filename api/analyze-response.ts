import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { evaluateTriggerGate } from "../lib/triggers.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import { analyzeResponse, truncateResponse } from "../lib/claude.js";
import { supabaseService } from "../lib/supabase.js";
import { validateConversationHistory } from "../lib/validate-history.js";
import { SYSTEM_PROMPT_VERSION } from "../prompts/system-prompt.js";
import type {
  AnalyzeRequestBody,
  ConversationTurn,
  Platform,
  Provocation,
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

function isValidBody(raw: unknown): raw is AnalyzeRequestBody {
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
  // conversation_history is optional; if present it must be an array.
  // Per-entry validation happens in validateConversationHistory which never
  // throws — it cleans/drops bad entries silently.
  if (b.conversation_history !== undefined && !Array.isArray(b.conversation_history)) {
    return false;
  }
  return true;
}

interface InsertRowInput {
  user_id: string;
  body: AnalyzeRequestBody;
  skipped: boolean;
  skip_reason: SkipReason | null;
  provocations: Provocation[];
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  latency_ms: number;
  history_turn_count: number;
  history_chars: number;
}

async function insertAnalysisRow(input: InsertRowInput): Promise<string | null> {
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
      provocation_count: input.provocations.length,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      cached_tokens: input.cached_tokens,
      latency_ms: input.latency_ms,
      prompt_version: SYSTEM_PROMPT_VERSION,
      provocations: input.provocations.length > 0 ? input.provocations : null,
      // Stored truncated to match what the analyzer actually saw — keeps the
      // explainer's view of the response consistent with the analyzer's.
      original_prompt: input.body.prompt,
      original_response: truncateResponse(input.body.response),
      conversation_history_turn_count: input.history_turn_count,
      conversation_history_chars: input.history_chars
    })
    .select("id")
    .single();

  if (error) {
    console.error("[analyze-response] insert failed", error);
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

    // Validate conversation_history once at the top so every downstream branch
    // (gate skip, quota, success, error) logs the same diagnostic counts.
    const history = validateConversationHistory(body.conversation_history);
    const cleanedHistory: ConversationTurn[] = history.cleaned;

    // Trigger gate — pure functions, no I/O. When prior turns exist, the
    // gate skips the trivial-word-count check (short follow-ups in real
    // conversations are the WHOLE POINT of multi-turn analysis).
    const gate = evaluateTriggerGate(body.prompt, body.response, history.turn_count > 0);
    if (gate.skip && gate.reason) {
      const analysisId = await insertAnalysisRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: gate.reason,
        provocations: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms: 0,
        history_turn_count: history.turn_count,
        history_chars: history.char_count
      });
      res.status(200).json({
        skip: true,
        reason: gate.reason,
        analysis_id: analysisId ?? ""
      });
      return;
    }

    // Quota — increments before Claude call. Per Q2(B) policy, parse_error and
    // claude_error still count toward quota since tokens were spent.
    const quota = await incrementResponseAnalysesQuota(user.user_id);
    if (quota.exceeded) {
      await insertAnalysisRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: "quota_exceeded",
        provocations: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms: 0,
        history_turn_count: history.turn_count,
        history_chars: history.char_count
      });
      res.status(429).json({
        error: "quota_exceeded",
        limit: quota.limit,
        used: quota.used
      });
      return;
    }

    // Claude call.
    const start = Date.now();
    let result;
    try {
      result = await analyzeResponse(body.prompt, body.response, cleanedHistory);
    } catch (err) {
      console.error("[analyze-response] claude error", err);
      const latency_ms = Date.now() - start;
      await insertAnalysisRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: "claude_error",
        provocations: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms,
        history_turn_count: history.turn_count,
        history_chars: history.char_count
      });
      res.status(500).json({ error: "internal" });
      return;
    }
    const latency_ms = Date.now() - start;

    if (!result.ok) {
      // Parse error — quota stays incremented.
      const analysisId = await insertAnalysisRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: "parse_error",
        provocations: [],
        tokens_in: result.usage.tokens_in,
        tokens_out: result.usage.tokens_out,
        cached_tokens: result.usage.cached_tokens,
        latency_ms,
        history_turn_count: history.turn_count,
        history_chars: history.char_count
      });
      res.status(200).json({
        skip: true,
        reason: "parse_error",
        analysis_id: analysisId ?? ""
      });
      return;
    }

    const provocations: Provocation[] = result.result.skip ? [] : result.result.provocations;
    const skipped = result.result.skip;

    const analysisId = await insertAnalysisRow({
      user_id: user.user_id,
      body,
      skipped,
      skip_reason: skipped ? "trivial" : null,
      provocations,
      tokens_in: result.usage.tokens_in,
      tokens_out: result.usage.tokens_out,
      cached_tokens: result.usage.cached_tokens,
      latency_ms,
      history_turn_count: history.turn_count,
      history_chars: history.char_count
    });

    if (!analysisId) {
      res.status(500).json({ error: "internal" });
      return;
    }

    if (skipped) {
      res.status(200).json({ skip: true, reason: "trivial", analysis_id: analysisId });
    } else {
      res.status(200).json({ skip: false, provocations, analysis_id: analysisId });
    }
  } catch (err) {
    console.error("[analyze-response] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
