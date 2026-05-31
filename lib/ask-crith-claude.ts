import Anthropic from "@anthropic-ai/sdk";
import {
  ASK_CRITH_VALIDATOR_PROMPT,
  buildAskCrithValidatorUserMessage
} from "../prompts/ask-crith-validator-prompt.js";
import {
  ASK_CRITH_EXTRACTOR_PROMPT,
  buildAskCrithExtractorUserMessage
} from "../prompts/ask-crith-extractor-prompt.js";
import { recoverAnchor } from "./anchor.js";
import type {
  ClaimExtractorResult,
  ClaudeAnalysisResult,
  ClaudeUsage,
  Validation,
  VerifiableClaim
} from "../types/index.js";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Missing required env var: ANTHROPIC_API_KEY");
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const VALIDATOR_TEMPERATURE = 0.3;
const EXTRACTOR_TEMPERATURE = 0.2;

const RETRY_REMINDER =
  "\n\nIMPORTANT: Return ONLY a JSON object. No preamble, no markdown fences, no explanation.";

// Match analyze-response's lens set plus the two ask-crith adds (sycophancy).
// hallucination is intentionally NOT included — that's the extractor's job.
const VALID_LENSES = new Set([
  "missing_angle",
  "hidden_assumption",
  "confidence_evidence_gap",
  "question_mismatch",
  "sycophancy"
]);
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);
const PROBLEM_MAX_CHARS = 300;
const FOLLOW_UP_MAX_CHARS = 450;
const SUPPRESSED_MAX = 4;

const VALID_CLAIM_TYPES = new Set([
  "statistic",
  "citation",
  "person_or_role",
  "date",
  "product_or_pricing",
  "current_state",
  "quote",
  "technical_fact",
  "ai_mistake",
  "actionable_recommendation"
]);
const VALID_RISKS = new Set(["high", "medium", "low"]);
const VALID_HALLUCINATION_SIGNALS = new Set(["high", "medium", "none"]);
const HALLUCINATION_REASON_MAX_CHARS = 80;
const MAX_CLAIMS = 3;

function extractFirstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Anchor recovery scoped to selectedText ONLY. ask-crith never critiques
// context_before / context_after, so anchors there are dropped.
function validateValidation(
  raw: unknown,
  selectedText: string,
  bucket: "validations" | "suppressed"
): Validation | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (
    typeof v.problem !== "string" ||
    typeof v.follow_up_prompt !== "string" ||
    typeof v.lens !== "string" ||
    typeof v.anchored_to !== "string" ||
    typeof v.severity !== "string"
  ) {
    return null;
  }
  if (!VALID_LENSES.has(v.lens) || !VALID_SEVERITIES.has(v.severity)) return null;
  if (v.problem.length === 0 || v.problem.length > PROBLEM_MAX_CHARS) {
    console.warn(`[ask-crith-claude] dropping ${bucket}: problem length out of range`, {
      length: v.problem.length,
      lens: v.lens
    });
    return null;
  }
  if (v.follow_up_prompt.length === 0 || v.follow_up_prompt.length > FOLLOW_UP_MAX_CHARS) {
    console.warn(`[ask-crith-claude] dropping ${bucket}: follow_up_prompt length out of range`, {
      length: v.follow_up_prompt.length,
      lens: v.lens
    });
    return null;
  }

  const recovered = recoverAnchor(v.anchored_to, selectedText);
  if (recovered === null) {
    console.warn(`[ask-crith-claude] dropping ${bucket}: anchor not in selection`, {
      lens: v.lens,
      anchored_to_preview: v.anchored_to.slice(0, 120)
    });
    return null;
  }

  return {
    problem: v.problem,
    follow_up_prompt: v.follow_up_prompt,
    lens: v.lens as Validation["lens"],
    anchored_to: recovered,
    severity: v.severity as Validation["severity"]
  };
}

function parseValidatorOutput(rawText: string, selectedText: string): ClaudeAnalysisResult | null {
  const jsonText = extractFirstJsonBlock(rawText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.skip !== "boolean") return null;
  if (!Array.isArray(obj.validations)) return null;
  const rawSuppressed = Array.isArray(obj.suppressed) ? obj.suppressed : [];

  if (obj.skip) return { skip: true, validations: [], suppressed: [] };

  const validations: Validation[] = [];
  for (const raw of obj.validations) {
    const v = validateValidation(raw, selectedText, "validations");
    if (v === null) {
      // Distinguish hard-fail (bad shape / enum) from soft-drop (length / anchor).
      // validateValidation returns null in BOTH cases. On hard-fail we want the
      // whole batch to fail so the retry path triggers; on soft-drop we just
      // skip the item.
      if (!raw || typeof raw !== "object") return null;
      const rv = raw as Record<string, unknown>;
      if (
        typeof rv.problem !== "string" ||
        typeof rv.follow_up_prompt !== "string" ||
        typeof rv.lens !== "string" ||
        typeof rv.anchored_to !== "string" ||
        typeof rv.severity !== "string" ||
        !VALID_LENSES.has(rv.lens as string) ||
        !VALID_SEVERITIES.has(rv.severity as string)
      ) {
        return null;
      }
      continue;
    }
    validations.push(v);
  }

  const suppressed: Validation[] = [];
  for (const raw of rawSuppressed.slice(0, SUPPRESSED_MAX)) {
    const v = validateValidation(raw, selectedText, "suppressed");
    if (v !== null) suppressed.push(v);
  }

  return { skip: false, validations, suppressed };
}

function validateClaim(raw: unknown, selectedText: string): VerifiableClaim | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.claim !== "string" ||
    typeof c.anchored_to !== "string" ||
    typeof c.claim_type !== "string" ||
    typeof c.why_verify !== "string" ||
    typeof c.risk !== "string" ||
    typeof c.hallucination_signal !== "string" ||
    typeof c.hallucination_reason !== "string"
  ) {
    return null;
  }
  if (!VALID_CLAIM_TYPES.has(c.claim_type)) return null;
  if (!VALID_RISKS.has(c.risk)) return null;
  if (!VALID_HALLUCINATION_SIGNALS.has(c.hallucination_signal)) return null;
  if (c.claim.length === 0 || c.claim.length > 400) return null;
  if (c.why_verify.length === 0 || c.why_verify.length > 200) return null;
  if (
    c.hallucination_reason.length === 0 ||
    c.hallucination_reason.length > HALLUCINATION_REASON_MAX_CHARS
  ) {
    return null;
  }

  const recovered = recoverAnchor(c.anchored_to, selectedText);
  if (recovered === null) {
    console.warn("[ask-crith-claude] dropping claim: anchor not in selection", {
      claim_type: c.claim_type,
      anchored_to_preview: c.anchored_to.slice(0, 120)
    });
    return null;
  }

  return {
    claim: c.claim,
    anchored_to: recovered,
    claim_type: c.claim_type as VerifiableClaim["claim_type"],
    why_verify: c.why_verify,
    risk: c.risk as VerifiableClaim["risk"],
    hallucination_signal: c.hallucination_signal as VerifiableClaim["hallucination_signal"],
    hallucination_reason: c.hallucination_reason
  };
}

function parseExtractorOutput(rawText: string, selectedText: string): ClaimExtractorResult | null {
  const jsonText = extractFirstJsonBlock(rawText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.skip !== "boolean") return null;
  if (!Array.isArray(obj.verifiable_claims)) return null;
  if (obj.skip) return { skip: true, verifiable_claims: [] };

  const claims: VerifiableClaim[] = [];
  for (const raw of obj.verifiable_claims) {
    if (claims.length >= MAX_CLAIMS) break;
    const c = validateClaim(raw, selectedText);
    if (c !== null) claims.push(c);
  }
  return { skip: false, verifiable_claims: claims };
}

interface CallSuccess<T> {
  ok: true;
  result: T;
  usage: ClaudeUsage;
}
interface CallFailure {
  ok: false;
  reason: "parse_error";
  usage: ClaudeUsage;
}

export type AskCrithValidatorCallResult = CallSuccess<ClaudeAnalysisResult> | CallFailure;
export type AskCrithExtractorCallResult = CallSuccess<ClaimExtractorResult> | CallFailure;

async function callOnce(
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  extraSuffix: string
): Promise<{ text: string; usage: ClaudeUsage }> {
  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature,
    system: [
      {
        type: "text",
        text: systemPrompt + extraSuffix,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: userMessage }]
  });

  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }

  const usage: ClaudeUsage = {
    tokens_in: message.usage.input_tokens,
    tokens_out: message.usage.output_tokens,
    cached_tokens: message.usage.cache_read_input_tokens ?? 0
  };
  return { text, usage };
}

export async function runAskCrithValidator(
  selectedText: string,
  contextBefore: string,
  contextAfter: string,
  originatingPrompt: string
): Promise<AskCrithValidatorCallResult> {
  const userMessage = buildAskCrithValidatorUserMessage(
    selectedText,
    contextBefore,
    contextAfter,
    originatingPrompt
  );

  const first = await callOnce(
    ASK_CRITH_VALIDATOR_PROMPT,
    userMessage,
    VALIDATOR_TEMPERATURE,
    ""
  );
  const firstParsed = parseValidatorOutput(first.text, selectedText);
  if (firstParsed) return { ok: true, result: firstParsed, usage: first.usage };

  const second = await callOnce(
    ASK_CRITH_VALIDATOR_PROMPT,
    userMessage,
    VALIDATOR_TEMPERATURE,
    RETRY_REMINDER
  );
  const totalUsage: ClaudeUsage = {
    tokens_in: first.usage.tokens_in + second.usage.tokens_in,
    tokens_out: first.usage.tokens_out + second.usage.tokens_out,
    cached_tokens: first.usage.cached_tokens + second.usage.cached_tokens
  };
  const secondParsed = parseValidatorOutput(second.text, selectedText);
  if (secondParsed) return { ok: true, result: secondParsed, usage: totalUsage };

  return { ok: false, reason: "parse_error", usage: totalUsage };
}

export async function runAskCrithExtractor(
  selectedText: string,
  contextBefore: string,
  contextAfter: string,
  originatingPrompt: string
): Promise<AskCrithExtractorCallResult> {
  const userMessage = buildAskCrithExtractorUserMessage(
    selectedText,
    contextBefore,
    contextAfter,
    originatingPrompt
  );

  const result = await callOnce(
    ASK_CRITH_EXTRACTOR_PROMPT,
    userMessage,
    EXTRACTOR_TEMPERATURE,
    ""
  );
  const parsed = parseExtractorOutput(result.text, selectedText);
  if (!parsed) return { ok: false, reason: "parse_error", usage: result.usage };
  return { ok: true, result: parsed, usage: result.usage };
}
