// lib/gemini.ts
import { recoverAnchor } from "./anchor.js";
import type {
  ClaimType,
  ExtractorResult,
  RawExtractedClaim
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
