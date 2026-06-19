// lib/gemini.ts
import { recoverAnchor } from "./anchor.js";
import {
  FACT_CHECK_EXTRACTOR_PROMPT,
  buildFactCheckUserMessage
} from "../prompts/fact-check-extractor-prompt.js";
import {
  FACT_CHECK_SELECTION_EXTRACTOR_PROMPT,
  buildFactCheckSelectionUserMessage
} from "../prompts/fact-check-selection-extractor-prompt.js";
import {
  buildFactCheckVerifierPrompt,
  buildFactCheckVerifierUserMessage
} from "../prompts/fact-check-verifier-prompt.js";
import type {
  ClaimType,
  ConversationTurn,
  ExtractorResult,
  GeminiUsage,
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
    // Spec contract: anchored_to is 30-80 chars. recoverAnchor enforces the
    // lower bound via ANCHOR_MIN_LEN; we enforce the upper bound here.
    if (recovered.length > 80) continue;

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

// Regex catches the shape; Date round-trip catches "2026-00-00" and similar
// out-of-range values that pass the regex but are not real calendar dates.
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

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
  if (typeof obj.as_of_date !== "string" || !isValidIsoDate(obj.as_of_date)) return null;

  // Normalize null and absent to undefined so the wire shape (optional) and the
  // internal shape (optional) match. Invalid string formats still hard-fail.
  let was_true_until: string | undefined;
  if (obj.was_true_until === undefined || obj.was_true_until === null) {
    was_true_until = undefined;
  } else if (typeof obj.was_true_until === "string" && isValidIsoDate(obj.was_true_until)) {
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

// --- Gemini REST client ---

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const TIMEOUT_MS = 15000;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    groundingMetadata?: unknown;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface GeminiCallSuccess {
  ok: true;
  text: string;
  usage: GeminiUsage;
}
interface GeminiCallFailure {
  ok: false;
  reason: "no_api_key" | "http_error" | "timeout" | "parse_error";
  status?: number;
}
type GeminiCallResult = GeminiCallSuccess | GeminiCallFailure;

async function callGemini(
  system: string,
  userMessage: string,
  withSearch: boolean
): Promise<GeminiCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
  };
  if (withSearch) {
    body.tools = [{ google_search: {} }];
  }

  let response: Response;
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "http_error" };
  }
  clearTimeout(timer);

  if (!response.ok) {
    console.error("[gemini] non-2xx", { status: response.status });
    return { ok: false, reason: "http_error", status: response.status };
  }

  let payload: GeminiResponse;
  try {
    payload = (await response.json()) as GeminiResponse;
  } catch {
    return { ok: false, reason: "parse_error" };
  }

  let text = "";
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (typeof p?.text === "string") text += p.text;
  }
  const usage: GeminiUsage = {
    tokens_in: payload.usageMetadata?.promptTokenCount ?? 0,
    tokens_out: payload.usageMetadata?.candidatesTokenCount ?? 0
  };
  return { ok: true, text, usage };
}

export interface ExtractorCallSuccess {
  ok: true;
  result: ExtractorResult;
  usage: GeminiUsage;
}
export interface ExtractorCallFailure {
  ok: false;
  reason: "parse_error" | "gemini_error";
  usage: GeminiUsage;
}
export type ExtractorCallResult = ExtractorCallSuccess | ExtractorCallFailure;

export async function factCheckExtract(
  userPrompt: string,
  aiResponse: string,
  conversationHistory?: ReadonlyArray<ConversationTurn>
): Promise<ExtractorCallResult> {
  const userMessage = buildFactCheckUserMessage(userPrompt, aiResponse, conversationHistory);
  const call = await callGemini(FACT_CHECK_EXTRACTOR_PROMPT, userMessage, false);
  if (!call.ok) {
    return { ok: false, reason: "gemini_error", usage: { tokens_in: 0, tokens_out: 0 } };
  }
  const parsed = parseExtractorResponse(call.text, aiResponse);
  if (!parsed) return { ok: false, reason: "parse_error", usage: call.usage };
  return { ok: true, result: parsed, usage: call.usage };
}

export async function factCheckSelectionExtract(
  selectedText: string,
  contextBefore: string,
  contextAfter: string,
  originatingPrompt: string
): Promise<ExtractorCallResult> {
  const userMessage = buildFactCheckSelectionUserMessage(
    selectedText,
    contextBefore,
    contextAfter,
    originatingPrompt
  );
  const call = await callGemini(FACT_CHECK_SELECTION_EXTRACTOR_PROMPT, userMessage, false);
  if (!call.ok) {
    return { ok: false, reason: "gemini_error", usage: { tokens_in: 0, tokens_out: 0 } };
  }
  const parsed = parseExtractorResponse(call.text, selectedText);
  if (!parsed) return { ok: false, reason: "parse_error", usage: call.usage };
  return { ok: true, result: parsed, usage: call.usage };
}

export interface VerifierCallSuccess {
  ok: true;
  result: VerifierResult;
  usage: GeminiUsage;
}
export interface VerifierCallFailure {
  ok: false;
  reason: "parse_error" | "gemini_error";
  usage: GeminiUsage;
}
export type VerifierCallResult = VerifierCallSuccess | VerifierCallFailure;

export async function factCheckVerify(
  claim: string,
  claimType: ClaimType
): Promise<VerifierCallResult> {
  const system = buildFactCheckVerifierPrompt(claimType);
  const userMessage = buildFactCheckVerifierUserMessage(claim);
  const call = await callGemini(system, userMessage, true);
  if (!call.ok) {
    return { ok: false, reason: "gemini_error", usage: { tokens_in: 0, tokens_out: 0 } };
  }
  const parsed = parseVerifierResponse(call.text);
  if (!parsed) return { ok: false, reason: "parse_error", usage: call.usage };
  return { ok: true, result: parsed, usage: call.usage };
}
