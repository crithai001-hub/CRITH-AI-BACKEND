// lib/gemini.ts
import { recoverAnchor } from "./anchor.js";
import type {
  ClaimType,
  ExtractorResult,
  RawExtractedClaim,
  Verdict,
  VerifierResult
} from "../types/index.js";

const MAX_CLAIMS = 3;
const VALID_CLAIM_TYPES = new Set<ClaimType>([
  "citation",
  "quote",
  "statistic",
  "factual"
]);

// Extract the first balanced { ... } JSON block from a possibly-noisy LLM
// response. Tolerates leading explanation, markdown fences, trailing prose.
export function extractFirstJsonBlock(text: string): string | null {
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

export function parseExtractorResponse(
  rawText: string,
  source: string
): ExtractorResult | null {
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
  if (!Array.isArray(obj.claims)) return null;

  if (obj.skip) {
    return { skip: true, claims: [] };
  }

  const claims: RawExtractedClaim[] = [];
  for (const raw of obj.claims.slice(0, MAX_CLAIMS)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (
      typeof c.claim_text !== "string" ||
      typeof c.anchored_to !== "string" ||
      typeof c.claim_type !== "string" ||
      typeof c.why_check !== "string"
    ) {
      continue;
    }
    if (!VALID_CLAIM_TYPES.has(c.claim_type as ClaimType)) continue;
    if (c.claim_text.length === 0 || c.claim_text.length > 400) continue;
    if (c.why_check.length === 0 || c.why_check.length > 200) continue;

    const recovered = recoverAnchor(c.anchored_to, source);
    if (recovered === null) continue;

    claims.push({
      claim_text: c.claim_text,
      anchored_to: recovered,
      claim_type: c.claim_type as ClaimType,
      why_check: c.why_check
    });
  }

  return { skip: false, claims };
}

const VALID_VERDICTS = new Set<Verdict>([
  "found_supporting",
  "found_contradicting",
  "could_not_verify",
  "error"
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseVerifierResponse(rawText: string): VerifierResult | null {
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

  if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict as Verdict)) {
    return null;
  }
  if (typeof obj.evidence !== "string") return null;
  if (!Array.isArray(obj.source_urls)) return null;
  if (typeof obj.as_of_date !== "string" || !ISO_DATE_RE.test(obj.as_of_date)) return null;

  // Normalize null and absent to undefined so the wire shape (optional) and the
  // internal shape (optional) match. Invalid string formats still hard-fail.
  let was_true_until: string | undefined;
  if (obj.was_true_until === undefined || obj.was_true_until === null) {
    was_true_until = undefined;
  } else if (typeof obj.was_true_until === "string" && ISO_DATE_RE.test(obj.was_true_until)) {
    was_true_until = obj.was_true_until;
  } else {
    return null;
  }

  if (typeof obj.follow_up_prompt !== "string") return null;
  const follow_up = obj.follow_up_prompt.trim();
  if (follow_up.length === 0) return null;
  const capped_follow_up = follow_up.length > 450 ? follow_up.slice(0, 450) : follow_up;

  const source_urls = obj.source_urls.filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );

  const result: VerifierResult = {
    verdict: obj.verdict as Verdict,
    evidence: obj.evidence,
    source_urls,
    as_of_date: obj.as_of_date,
    follow_up_prompt: capped_follow_up
  };
  if (was_true_until !== undefined) result.was_true_until = was_true_until;
  return result;
}
