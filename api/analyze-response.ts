import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { evaluateTriggerGate } from "../lib/triggers.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import { analyzeResponse, truncateResponse } from "../lib/claude.js";
import { extractClaims } from "../lib/claim-extractor.js";
import { anchorsOverlap } from "../lib/anchor.js";
import { supabaseService } from "../lib/supabase.js";
import { validateConversationHistory } from "../lib/validate-history.js";
import { SYSTEM_PROMPT_VERSION } from "../prompts/system-prompt.js";
import { CLAIM_EXTRACTOR_VERSION } from "../prompts/claim-extractor-prompt.js";
import type {
  AnalyzeRequestBody,
  ConversationTurn,
  Platform,
  PromptVersions,
  SkipReason,
  Validation,
  VerifiableClaim
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
  validations: Validation[];
  verifiable_claims: VerifiableClaim[];
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  latency_ms: number;
  history_turn_count: number;
  history_chars: number;
  claim_extractor_version: string | null;
  claim_extractor_tokens_in: number | null;
  claim_extractor_tokens_out: number | null;
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
      provocation_count: input.validations.length,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      cached_tokens: input.cached_tokens,
      latency_ms: input.latency_ms,
      prompt_version: SYSTEM_PROMPT_VERSION,
      // v14+ schema. Old `provocations` column stays nullable for legacy rows;
      // we no longer write to it. New writes go to `validations` only.
      validations: input.validations,
      verifiable_claims: input.verifiable_claims,
      claim_extractor_version: input.claim_extractor_version,
      claim_extractor_tokens_in: input.claim_extractor_tokens_in,
      claim_extractor_tokens_out: input.claim_extractor_tokens_out,
      // Stored truncated to match what the analyzer actually saw — keeps any
      // downstream consumer's view of the response consistent with the analyzer's.
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
        validations: [],
        verifiable_claims: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms: 0,
        history_turn_count: history.turn_count,
        history_chars: history.char_count,
        claim_extractor_version: null,
        claim_extractor_tokens_in: null,
        claim_extractor_tokens_out: null
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
        validations: [],
        verifiable_claims: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms: 0,
        history_turn_count: history.turn_count,
        history_chars: history.char_count,
        claim_extractor_version: null,
        claim_extractor_tokens_in: null,
        claim_extractor_tokens_out: null
      });
      res.status(429).json({
        error: "quota_exceeded",
        limit: quota.limit,
        used: quota.used
      });
      return;
    }

    // Parallel Haiku calls: validator (gap-spotting) + claim extractor (fact-checking).
    // Promise.allSettled so one failure doesn't kill the other. Quota was already
    // incremented above; both calls share that single quota slot.
    const start = Date.now();
    const [validatorSettled, extractorSettled] = await Promise.allSettled([
      analyzeResponse(body.prompt, body.response, cleanedHistory),
      extractClaims(body.prompt, body.response)
    ]);
    const latency_ms = Date.now() - start;

    if (validatorSettled.status === "rejected") {
      console.error("[analyze-response] validator rejected", validatorSettled.reason);
    } else if (!validatorSettled.value.ok) {
      console.warn("[analyze-response] validator parse_error");
    }

    if (extractorSettled.status === "rejected") {
      console.error("[analyze-response] extractor rejected", extractorSettled.reason);
    } else if (!extractorSettled.value.ok) {
      console.warn("[analyze-response] extractor parse_error");
    }

    const validatorOk = validatorSettled.status === "fulfilled" && validatorSettled.value.ok;
    const extractorOk = extractorSettled.status === "fulfilled" && extractorSettled.value.ok;

    // Both failed — full failure. Persist whatever usage we got and 500.
    if (!validatorOk && !extractorOk) {
      const validatorUsage =
        validatorSettled.status === "fulfilled" ? validatorSettled.value.usage : null;
      const extractorUsage =
        extractorSettled.status === "fulfilled" ? extractorSettled.value.usage : null;
      await insertAnalysisRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: validatorSettled.status === "rejected" ? "claude_error" : "parse_error",
        validations: [],
        verifiable_claims: [],
        tokens_in: validatorUsage?.tokens_in ?? 0,
        tokens_out: validatorUsage?.tokens_out ?? 0,
        cached_tokens: validatorUsage?.cached_tokens ?? 0,
        latency_ms,
        history_turn_count: history.turn_count,
        history_chars: history.char_count,
        claim_extractor_version: CLAIM_EXTRACTOR_VERSION,
        claim_extractor_tokens_in: extractorUsage?.tokens_in ?? null,
        claim_extractor_tokens_out: extractorUsage?.tokens_out ?? null
      });
      res.status(500).json({ error: "internal" });
      return;
    }

    // At least one succeeded — pull usable results.
    const validatorResult =
      validatorSettled.status === "fulfilled" && validatorSettled.value.ok
        ? validatorSettled.value
        : null;
    const extractorResult =
      extractorSettled.status === "fulfilled" && extractorSettled.value.ok
        ? extractorSettled.value
        : null;

    const rawValidations: Validation[] =
      validatorResult && !validatorResult.result.skip ? validatorResult.result.validations : [];
    const verifiable_claims: VerifiableClaim[] =
      extractorResult && !extractorResult.result.skip
        ? extractorResult.result.verifiable_claims
        : [];

    // Dedup: drop any validation whose anchor span overlaps with a claim's
    // anchor span. The claim wins — factual wrongness is more specific than
    // a reasoning gap on the same content. Belt-and-suspenders for v19's
    // prompt-level rule that forbids the validator from anchoring on facts.
    const validations: Validation[] = rawValidations.filter((v) => {
      const overlap = verifiable_claims.find((c) =>
        anchorsOverlap(body.response, v.anchored_to, c.anchored_to)
      );
      if (overlap) {
        console.info("[analyze-response] dropping validation: overlaps claim anchor", {
          lens: v.lens,
          validation_anchor_preview: v.anchored_to.slice(0, 80),
          claim_anchor_preview: overlap.anchored_to.slice(0, 80)
        });
        return false;
      }
      return true;
    });

    const validatorSkipped = validatorResult ? validatorResult.result.skip : true;
    // Top-level skip only when validator skipped AND no claims to surface.
    // Extension treats skip:true as "no card"; if claims are present we want it rendered.
    const skipped = validatorSkipped && verifiable_claims.length === 0;

    const validatorUsage = validatorResult?.usage;
    const extractorUsage = extractorResult?.usage;

    const analysisId = await insertAnalysisRow({
      user_id: user.user_id,
      body,
      skipped,
      skip_reason: skipped ? "trivial" : null,
      validations,
      verifiable_claims,
      tokens_in: validatorUsage?.tokens_in ?? 0,
      tokens_out: validatorUsage?.tokens_out ?? 0,
      cached_tokens: validatorUsage?.cached_tokens ?? 0,
      latency_ms,
      history_turn_count: history.turn_count,
      history_chars: history.char_count,
      claim_extractor_version: CLAIM_EXTRACTOR_VERSION,
      claim_extractor_tokens_in: extractorUsage?.tokens_in ?? null,
      claim_extractor_tokens_out: extractorUsage?.tokens_out ?? null
    });

    if (!analysisId) {
      res.status(500).json({ error: "internal" });
      return;
    }

    const prompt_versions: PromptVersions = {
      validator: SYSTEM_PROMPT_VERSION,
      claim_extractor: CLAIM_EXTRACTOR_VERSION
    };

    if (skipped) {
      res.status(200).json({ skip: true, reason: "trivial", analysis_id: analysisId });
      return;
    }

    res.status(200).json({
      skip: false,
      validations,
      verifiable_claims,
      analysis_id: analysisId,
      prompt_versions
    });
  } catch (err) {
    console.error("[analyze-response] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
