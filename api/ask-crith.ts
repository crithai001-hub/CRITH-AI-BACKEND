import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { evaluateAskCrithGate } from "../lib/ask-crith-triggers.js";
import { incrementResponseAnalysesQuota } from "../lib/quota.js";
import {
  runAskCrithValidator,
  runAskCrithExtractor
} from "../lib/ask-crith-claude.js";
import { anchorsOverlap } from "../lib/anchor.js";
import { pickInlineFlag } from "../lib/inline-pick.js";
import { buildFlags, enrichClaims } from "../lib/flag-pipeline.js";
import { inlineVerify } from "../lib/inline-verify.js";
import { supabaseService } from "../lib/supabase.js";
import {
  ASK_CRITH_VALIDATOR_VERSION
} from "../prompts/ask-crith-validator-prompt.js";
import {
  ASK_CRITH_EXTRACTOR_VERSION
} from "../prompts/ask-crith-extractor-prompt.js";
import type {
  AskCrithRequestBody,
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

const SELECTION_MIN = 40;
const SELECTION_MAX = 5000;
const CONTEXT_MAX = 200;
const PROMPT_MAX = 2000;

export function isValidBody(raw: unknown): raw is AskCrithRequestBody {
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
  if (b.selected_text.length < SELECTION_MIN || b.selected_text.length > SELECTION_MAX) {
    return false;
  }
  if (b.context_before.length > CONTEXT_MAX) return false;
  if (b.context_after.length > CONTEXT_MAX) return false;
  if (b.prompt.length > PROMPT_MAX) return false;
  return true;
}

interface InsertRowInput {
  user_id: string;
  body: AskCrithRequestBody;
  skipped: boolean;
  skip_reason: SkipReason | null;
  validations: Validation[];
  suppressed_validations: Validation[];
  verifiable_claims: VerifiableClaim[];
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
  latency_ms: number;
  claim_extractor_version: string | null;
  claim_extractor_tokens_in: number | null;
  claim_extractor_tokens_out: number | null;
}

async function insertAskCrithRow(input: InsertRowInput): Promise<string | null> {
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
      provocation_count: input.validations.length,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      cached_tokens: input.cached_tokens,
      latency_ms: input.latency_ms,
      prompt_version: ASK_CRITH_VALIDATOR_VERSION,
      validations: input.validations,
      suppressed_validations: input.suppressed_validations,
      verifiable_claims: input.verifiable_claims,
      claim_extractor_version: input.claim_extractor_version,
      claim_extractor_tokens_in: input.claim_extractor_tokens_in,
      claim_extractor_tokens_out: input.claim_extractor_tokens_out,
      original_prompt: input.body.prompt,
      original_response: input.body.selected_text,
      conversation_history_turn_count: 0,
      conversation_history_chars: 0,
      analysis_kind: "ask_crith",
      ask_context_before: input.body.context_before,
      ask_context_after: input.body.context_after
    })
    .select("id")
    .single();

  if (error) {
    console.error("[ask-crith] insert failed", error);
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

    // Trigger gate.
    const gate = evaluateAskCrithGate(body.selected_text);
    if (gate.skip && gate.reason) {
      const analysisId = await insertAskCrithRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: gate.reason,
        validations: [],
        suppressed_validations: [],
        verifiable_claims: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms: 0,
        claim_extractor_version: null,
        claim_extractor_tokens_in: null,
        claim_extractor_tokens_out: null
      });
      console.info("[ask-crith] gate skip", {
        reason: gate.reason,
        platform: body.platform,
        selection_preview: body.selected_text.slice(0, 80)
      });
      res.status(200).json({
        skip: true,
        reason: gate.reason,
        analysis_id: analysisId ?? ""
      });
      return;
    }

    // Quota.
    const quota = await incrementResponseAnalysesQuota(user.user_id);
    if (quota.exceeded) {
      await insertAskCrithRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: "quota_exceeded",
        validations: [],
        suppressed_validations: [],
        verifiable_claims: [],
        tokens_in: 0,
        tokens_out: 0,
        cached_tokens: 0,
        latency_ms: 0,
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

    // Parallel Haiku calls.
    const start = Date.now();
    const [validatorSettled, extractorSettled] = await Promise.allSettled([
      runAskCrithValidator(
        body.selected_text,
        body.context_before,
        body.context_after,
        body.prompt
      ),
      runAskCrithExtractor(
        body.selected_text,
        body.context_before,
        body.context_after,
        body.prompt
      )
    ]);
    const latency_ms = Date.now() - start;

    if (validatorSettled.status === "rejected") {
      console.error("[ask-crith] validator rejected", validatorSettled.reason);
    } else if (!validatorSettled.value.ok) {
      console.warn("[ask-crith] validator parse_error");
    }
    if (extractorSettled.status === "rejected") {
      console.error("[ask-crith] extractor rejected", extractorSettled.reason);
    } else if (!extractorSettled.value.ok) {
      console.warn("[ask-crith] extractor parse_error");
    }

    const validatorOk = validatorSettled.status === "fulfilled" && validatorSettled.value.ok;
    const extractorOk = extractorSettled.status === "fulfilled" && extractorSettled.value.ok;

    if (!validatorOk && !extractorOk) {
      const validatorUsage =
        validatorSettled.status === "fulfilled" ? validatorSettled.value.usage : null;
      const extractorUsage =
        extractorSettled.status === "fulfilled" ? extractorSettled.value.usage : null;
      await insertAskCrithRow({
        user_id: user.user_id,
        body,
        skipped: true,
        skip_reason: validatorSettled.status === "rejected" ? "claude_error" : "parse_error",
        validations: [],
        suppressed_validations: [],
        verifiable_claims: [],
        tokens_in: validatorUsage?.tokens_in ?? 0,
        tokens_out: validatorUsage?.tokens_out ?? 0,
        cached_tokens: validatorUsage?.cached_tokens ?? 0,
        latency_ms,
        claim_extractor_version: ASK_CRITH_EXTRACTOR_VERSION,
        claim_extractor_tokens_in: extractorUsage?.tokens_in ?? null,
        claim_extractor_tokens_out: extractorUsage?.tokens_out ?? null
      });
      res.status(500).json({ error: "internal" });
      return;
    }

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
    const rawSuppressed: Validation[] =
      validatorResult && !validatorResult.result.skip ? validatorResult.result.suppressed : [];
    const verifiable_claims: VerifiableClaim[] =
      extractorResult && !extractorResult.result.skip
        ? extractorResult.result.verifiable_claims
        : [];

    // Defensive post-check: anchored_to MUST be a verbatim substring of
    // selected_text. The Claude wrapper already enforces this via recoverAnchor,
    // but the second pass here catches any drift and emits a clear log line.
    const dropIfNotInSelection = (items: Validation[], tier: string): Validation[] =>
      items.filter((v) => {
        const ok = body.selected_text.includes(v.anchored_to);
        if (!ok) {
          console.info(`[ask-crith] dropping ${tier}: anchor not in selection`, {
            lens: v.lens,
            anchor_preview: v.anchored_to.slice(0, 80)
          });
        }
        return ok;
      });
    const claimsInSelection = verifiable_claims.filter((c) => {
      const ok = body.selected_text.includes(c.anchored_to);
      if (!ok) {
        console.info("[ask-crith] dropping claim: anchor not in selection", {
          claim_type: c.claim_type,
          anchor_preview: c.anchored_to.slice(0, 80)
        });
      }
      return ok;
    });

    // Dedup validations against claim anchors (same rule as analyze-response).
    const dedupAgainstClaims = (items: Validation[], tier: string): Validation[] =>
      items.filter((v) => {
        const overlap = claimsInSelection.find((c) =>
          anchorsOverlap(body.selected_text, v.anchored_to, c.anchored_to)
        );
        if (overlap) {
          console.info(`[ask-crith] dropping ${tier} item: overlaps claim anchor`, {
            lens: v.lens,
            item_anchor_preview: v.anchored_to.slice(0, 80),
            claim_anchor_preview: overlap.anchored_to.slice(0, 80)
          });
          return false;
        }
        return true;
      });
    const validations = dedupAgainstClaims(
      dropIfNotInSelection(rawValidations, "validation"),
      "validation"
    );
    const suppressed_validations = dedupAgainstClaims(
      dropIfNotInSelection(rawSuppressed, "suppressed"),
      "suppressed"
    );

    const validatorSkipped = validatorResult ? validatorResult.result.skip : true;
    // Treat as skipped when there's nothing left to render after anchor enforcement +
    // dedup, regardless of whether the validator itself declared skip. This covers
    // the case where validator returned items but all anchors failed the
    // selected_text substring check.
    const skipped =
      validations.length === 0 &&
      suppressed_validations.length === 0 &&
      claimsInSelection.length === 0;

    const validatorFailureReason: SkipReason | null = validatorOk
      ? null
      : validatorSettled.status === "rejected"
        ? "claude_error"
        : "parse_error";
    const skipReason: SkipReason | null = skipped
      ? (validatorFailureReason ?? "ask_no_substance")
      : null;

    const validatorUsage = validatorResult?.usage;
    const extractorUsage = extractorResult?.usage;

    const analysisId = await insertAskCrithRow({
      user_id: user.user_id,
      body,
      skipped,
      skip_reason: skipReason,
      validations,
      suppressed_validations,
      verifiable_claims: claimsInSelection,
      tokens_in: validatorUsage?.tokens_in ?? 0,
      tokens_out: validatorUsage?.tokens_out ?? 0,
      cached_tokens: validatorUsage?.cached_tokens ?? 0,
      latency_ms,
      claim_extractor_version: ASK_CRITH_EXTRACTOR_VERSION,
      claim_extractor_tokens_in: extractorUsage?.tokens_in ?? null,
      claim_extractor_tokens_out: extractorUsage?.tokens_out ?? null
    });

    if (!analysisId) {
      res.status(500).json({ error: "internal" });
      return;
    }

    const prompt_versions: PromptVersions = {
      validator: ASK_CRITH_VALIDATOR_VERSION,
      claim_extractor: ASK_CRITH_EXTRACTOR_VERSION
    };

    console.info("[ask-crith] result", {
      platform: body.platform,
      selection_preview: body.selected_text.slice(0, 80),
      latency_ms,
      flag_count: validations.length + suppressed_validations.length,
      claim_count: claimsInSelection.length,
      skipped,
      skip_reason: skipReason
    });

    if (skipped) {
      res.status(200).json({ skip: true, reason: skipReason!, analysis_id: analysisId });
      return;
    }

    const flags = buildFlags(validations, suppressed_validations, analysisId);
    const inline_flag_id = pickInlineFlag(flags, body.prompt.length);
    const enrichedClaims = enrichClaims(claimsInSelection, analysisId);

    // Inline verification: run verifier in parallel for all eligible claims,
    // gated by quota. Budget is computed up-front (serial quota increments) so
    // we never queue more than the user's remaining allowance.
    const verifyStart = Date.now();
    const eligible = enrichedClaims.filter((c) => c.verify);
    let verifyBudget = 0;
    for (let i = 0; i < eligible.length; i++) {
      const q = await incrementResponseAnalysesQuota(user.user_id);
      if (q.exceeded) break;
      verifyBudget++;
    }
    const toVerify = eligible.slice(0, verifyBudget);
    const rawByIndex = new Map(claimsInSelection.map((c, idx) => [idx, c]));
    const verifyResults = await Promise.all(
      toVerify.map((c) =>
        inlineVerify(rawByIndex.get(c.claim_index)!, analysisId, c.claim_index, user.user_id)
      )
    );
    // Attach results back onto enrichedClaims by claim_index (not array position).
    let verifiedCount = 0;
    let failedCount = 0;
    for (let i = 0; i < toVerify.length; i++) {
      const result = verifyResults[i];
      const target = enrichedClaims.find((c) => c.claim_index === toVerify[i]!.claim_index);
      if (!target) continue;
      if (!result) {
        failedCount++;
        continue;
      }
      target.verdict = result.verdict;
      target.evidence = result.evidence;
      target.source_urls = result.source_urls;
      target.verification_id = result.verification_id;
      verifiedCount++;
    }
    const verifyLatency = Date.now() - verifyStart;
    console.info("[ask-crith] inline-verify summary", {
      eligible: eligible.length,
      budget: verifyBudget,
      verified: verifiedCount,
      failed: failedCount,
      verify_latency_ms: verifyLatency
    });

    res.status(200).json({
      skip: false,
      validations,
      suppressed: suppressed_validations,
      flags,
      inline_flag_id,
      verifiable_claims: enrichedClaims,
      analysis_id: analysisId,
      prompt_versions
    });
  } catch (err) {
    console.error("[ask-crith] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
