import Anthropic from "@anthropic-ai/sdk";
import {
  CLAIM_EXTRACTOR_PROMPT,
  buildClaimExtractorUserMessage
} from "../prompts/claim-extractor-prompt.js";
import { recoverAnchor } from "./anchor.js";
import type {
  ClaimExtractorResult,
  ClaudeUsage,
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
const TEMPERATURE = 0.2;
const MAX_RESPONSE_CHARS = 12000;
const TRUNCATION_MARKER = "\n\n[...truncated...]";
const MAX_CLAIMS = 3;

const VALID_CLAIM_TYPES = new Set([
  "statistic",
  "citation",
  "person_or_role",
  "date",
  "product_or_pricing",
  "current_state",
  "quote",
  "technical_fact"
]);
const VALID_RISKS = new Set(["high", "medium", "low"]);

function truncate(s: string): string {
  return s.length <= MAX_RESPONSE_CHARS ? s : s.slice(0, MAX_RESPONSE_CHARS) + TRUNCATION_MARKER;
}

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

export function parseClaimExtractorResponse(
  rawText: string,
  aiResponse: string
): ClaimExtractorResult | null {
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

  if (obj.skip && obj.verifiable_claims.length > 0) {
    return { skip: true, verifiable_claims: [] };
  }

  const claims: VerifiableClaim[] = [];
  for (const raw of obj.verifiable_claims) {
    if (claims.length >= MAX_CLAIMS) break;
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (
      typeof c.claim !== "string" ||
      typeof c.anchored_to !== "string" ||
      typeof c.claim_type !== "string" ||
      typeof c.why_verify !== "string" ||
      typeof c.risk !== "string"
    ) {
      continue;
    }
    if (!VALID_CLAIM_TYPES.has(c.claim_type)) continue;
    if (!VALID_RISKS.has(c.risk)) continue;
    if (c.claim.length === 0 || c.claim.length > 400) continue;
    if (c.why_verify.length === 0 || c.why_verify.length > 200) continue;

    // Anchor recovery: same discipline as the validator. Keep if verbatim;
    // otherwise recover the closest verbatim slice; only drop if no usable
    // substring exists.
    const recovered = recoverAnchor(c.anchored_to, aiResponse);
    if (recovered === null) {
      console.warn("[claim-extractor] dropping claim: anchor not recoverable", {
        claim_type: c.claim_type,
        anchored_to_preview: c.anchored_to.slice(0, 120)
      });
      continue;
    }
    if (recovered !== c.anchored_to) {
      console.info("[claim-extractor] anchor recovered", {
        claim_type: c.claim_type,
        original_preview: c.anchored_to.slice(0, 120),
        recovered_preview: recovered.slice(0, 120)
      });
    }

    claims.push({
      claim: c.claim,
      anchored_to: recovered,
      claim_type: c.claim_type as VerifiableClaim["claim_type"],
      why_verify: c.why_verify,
      risk: c.risk as VerifiableClaim["risk"]
    });
  }

  return { skip: obj.skip, verifiable_claims: claims };
}

interface CallSuccess {
  ok: true;
  result: ClaimExtractorResult;
  usage: ClaudeUsage;
}
interface CallFailure {
  ok: false;
  reason: "parse_error";
  usage: ClaudeUsage;
}
export type ClaimExtractorCallResult = CallSuccess | CallFailure;

export async function extractClaims(
  userPrompt: string,
  aiResponse: string
): Promise<ClaimExtractorCallResult> {
  const truncated = truncate(aiResponse);
  const userMessage = buildClaimExtractorUserMessage(userPrompt, truncated);

  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: CLAIM_EXTRACTOR_PROMPT,
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

  const parsed = parseClaimExtractorResponse(text, truncated);
  if (!parsed) return { ok: false, reason: "parse_error", usage };
  return { ok: true, result: parsed, usage };
}
