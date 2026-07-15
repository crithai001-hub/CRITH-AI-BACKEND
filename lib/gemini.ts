// lib/gemini.ts
import { recoverAnchor } from "./anchor.js";
import {
  FACT_CHECK_COMBINED_PROMPT,
  buildFactCheckCombinedUserMessage
} from "../prompts/fact-check-combined-prompt.js";
import {
  FACT_CHECK_SELECTION_COMBINED_PROMPT,
  buildFactCheckSelectionCombinedUserMessage
} from "../prompts/fact-check-selection-combined-prompt.js";
import {
  FACT_CHECK_VERIFIER_PROMPT,
  buildFactCheckVerifierUserMessage
} from "../prompts/fact-check-verifier-prompt.js";
import type {
  ClaimSubtype,
  ClaimType,
  CombinedCheckResult,
  ConversationTurn,
  GeminiUsage,
  RawExtractedClaim,
  RawVerifiedClaim,
  Verdict,
  VerifierResult
} from "../types/index.js";

const MAX_CLAIMS = 3;
const VALID_CLAIM_TYPES = new Set<ClaimType>(["factual", "prescriptive"]);
const VALID_CLAIM_SUBTYPES = new Set<ClaimSubtype>([
  "citation",
  "statistic",
  "quote",
  "entity",
  "general"
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


const VALID_VERDICTS = new Set<Verdict>([
  "supported",
  "contradicted",
  "unverified",
  "error"
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

// Date regexes catch shape; Date round-trip catches "2026-00-00" / "2026-13"
// and similar out-of-range values that pass the regex but are not real
// calendar dates / months.
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function isValidYearMonth(s: string): boolean {
  if (!YEAR_MONTH_RE.test(s)) return false;
  const month = parseInt(s.slice(5, 7), 10);
  return month >= 1 && month <= 12;
}

function isValidWasTrueUntil(s: string): boolean {
  return isValidIsoDate(s) || isValidYearMonth(s);
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
  const verdict = obj.verdict as Verdict;

  if (typeof obj.evidence !== "string") return null;
  if (!Array.isArray(obj.source_urls)) return null;
  if (typeof obj.as_of_date !== "string" || !isValidIsoDate(obj.as_of_date)) return null;

  // was_true_until: accept YYYY-MM (preferred per prompt) or YYYY-MM-DD.
  // null and absent both normalize to undefined; invalid strings hard-fail.
  let was_true_until: string | undefined;
  if (obj.was_true_until === undefined || obj.was_true_until === null) {
    was_true_until = undefined;
  } else if (
    typeof obj.was_true_until === "string" &&
    isValidWasTrueUntil(obj.was_true_until)
  ) {
    was_true_until = obj.was_true_until;
  } else {
    return null;
  }

  // follow_up_prompt is null when verdict === "supported". null and absent
  // both normalize to undefined. Non-empty strings are trimmed and capped.
  let follow_up_prompt: string | undefined;
  if (obj.follow_up_prompt === undefined || obj.follow_up_prompt === null) {
    follow_up_prompt = undefined;
  } else if (typeof obj.follow_up_prompt === "string") {
    const trimmed = obj.follow_up_prompt.trim();
    if (trimmed.length === 0) {
      follow_up_prompt = undefined;
    } else {
      follow_up_prompt = trimmed.length > 450 ? trimmed.slice(0, 450) : trimmed;
    }
  } else {
    return null;
  }

  const source_urls = obj.source_urls.filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );

  const result: VerifierResult = {
    verdict,
    evidence: obj.evidence,
    source_urls,
    as_of_date: obj.as_of_date
  };
  if (was_true_until !== undefined) result.was_true_until = was_true_until;
  if (follow_up_prompt !== undefined) result.follow_up_prompt = follow_up_prompt;
  return result;
}

const COMBINED_VERDICTS = new Set<Verdict>(["supported", "contradicted", "unverified"]);

// Search-query URLs are not sources — models sometimes emit the queries they
// ran instead of the pages they found.
function isSearchQueryUrl(u: string): boolean {
  return /^https?:\/\/(www\.)?(google|bing|duckduckgo)\.[^/]+\/search/i.test(u);
}

function parseCombinedVerification(
  raw: unknown,
  fallbackSourceUrls: string[]
): RawVerifiedClaim["verification"] | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;

  if (typeof v.verdict !== "string" || !COMBINED_VERDICTS.has(v.verdict as Verdict)) return null;
  if (typeof v.evidence !== "string" || v.evidence.length === 0) return null;
  if (!Array.isArray(v.source_urls)) return null;
  if (typeof v.as_of_date !== "string" || !isValidIsoDate(v.as_of_date)) return null;

  let was_true_until: string | undefined;
  if (v.was_true_until === undefined || v.was_true_until === null) {
    was_true_until = undefined;
  } else if (typeof v.was_true_until === "string" && isValidWasTrueUntil(v.was_true_until)) {
    was_true_until = v.was_true_until;
  } else {
    return null;
  }

  let follow_up_prompt: string | undefined;
  if (v.follow_up_prompt === undefined || v.follow_up_prompt === null) {
    follow_up_prompt = undefined;
  } else if (typeof v.follow_up_prompt === "string") {
    const trimmed = v.follow_up_prompt.trim();
    follow_up_prompt =
      trimmed.length === 0 ? undefined : trimmed.length > 450 ? trimmed.slice(0, 450) : trimmed;
  } else {
    return null;
  }

  let source_urls = v.source_urls
    .filter((u): u is string => typeof u === "string" && u.length > 0 && !isSearchQueryUrl(u))
    .slice(0, 5);
  // Grounded search ran real queries even when the model's JSON omits the
  // pages it read — backfill from grounding metadata before downgrading.
  if (source_urls.length === 0 && fallbackSourceUrls.length > 0) {
    source_urls = fallbackSourceUrls.slice(0, 3);
  }

  // Precision rule: an assertive verdict without at least one source is
  // downgraded to unverified rather than trusted.
  let verdict = v.verdict as Verdict;
  if (source_urls.length === 0 && verdict !== "unverified") {
    verdict = "unverified";
  }

  const result: RawVerifiedClaim["verification"] = {
    verdict,
    evidence: v.evidence,
    source_urls,
    as_of_date: v.as_of_date
  };
  if (was_true_until !== undefined) result.was_true_until = was_true_until;
  if (follow_up_prompt !== undefined) result.follow_up_prompt = follow_up_prompt;
  return result;
}

export function parseCombinedResponse(
  rawText: string,
  source: string,
  groundingUrls: string[] = []
): CombinedCheckResult | null {
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

  const claimsArray = Array.isArray(obj.claims) ? obj.claims : null;
  if (claimsArray === null) return null;
  if (obj.skip === true) return { skip: true, claims: [] };

  const claims: RawVerifiedClaim[] = [];
  for (const raw of claimsArray.slice(0, MAX_CLAIMS)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (
      typeof c.claim_text !== "string" ||
      typeof c.anchored_to !== "string" ||
      typeof c.claim_type !== "string" ||
      typeof c.claim_subtype !== "string" ||
      typeof c.why_check !== "string"
    ) {
      continue;
    }
    if (!VALID_CLAIM_TYPES.has(c.claim_type as ClaimType)) continue;
    if (!VALID_CLAIM_SUBTYPES.has(c.claim_subtype as ClaimSubtype)) continue;
    if (c.claim_text.length === 0 || c.claim_text.length > 400) continue;
    if (c.why_check.length === 0 || c.why_check.length > 200) continue;

    const recovered = recoverAnchor(c.anchored_to, source);
    if (recovered === null) continue;
    // Models often anchor to a whole sentence; a prefix of a verbatim
    // substring is still verbatim, so truncate rather than drop the claim.
    const anchor = recovered.length > 80 ? recovered.slice(0, 80) : recovered;

    const verification = parseCombinedVerification(c.verification, groundingUrls);
    if (verification === null) continue;

    claims.push({
      claim_text: c.claim_text,
      anchored_to: anchor,
      claim_type: c.claim_type as ClaimType,
      claim_subtype: c.claim_subtype as ClaimSubtype,
      why_check: c.why_check,
      verification
    });
  }

  return { skip: false, claims };
}

// --- Gemini REST client ---

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const VERIFY_TIMEOUT_MS = 30000; // grounded search needs more headroom

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: unknown } }>;
    };
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
  groundingUrls: string[];
}
interface GeminiCallFailure {
  ok: false;
  reason: "no_api_key" | "http_error" | "timeout" | "parse_error";
  status?: number;
}
type GeminiCallResult = GeminiCallSuccess | GeminiCallFailure;

interface GeminiCallOptions {
  withSearch: boolean;
  timeoutMs: number;
  disableThinking?: boolean;
  maxOutputTokens?: number;
}

// system === null sends the entire prompt in the user message. Required for
// grounded calls: with a systemInstruction, Gemini 2.5 Flash skips the
// google_search tool entirely and fabricates "I searched" verdicts from
// memory (observed live 2026-07-15; user-message placement fires reliably).
async function callGemini(
  system: string | null,
  userMessage: string,
  opts: GeminiCallOptions
): Promise<GeminiCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  const generationConfig: Record<string, unknown> = {
    temperature: 0.1,
    maxOutputTokens: opts.maxOutputTokens ?? (opts.withSearch ? 2048 : 1024)
  };
  if (opts.disableThinking) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig
  };
  if (system !== null) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (opts.withSearch) {
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
  const groundingUrls: string[] = [];
  for (const chunk of payload.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const uri = chunk?.web?.uri;
    if (typeof uri === "string" && uri.length > 0 && !groundingUrls.includes(uri)) {
      groundingUrls.push(uri);
    }
  }
  return { ok: true, text, usage, groundingUrls };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Real grounded search costs 6.5-11.5s per live measurement; 15s leaves
// headroom without letting the extension hang.
const COMBINED_TIMEOUT_MS = 15000;

export interface CombinedCallSuccess {
  ok: true;
  result: CombinedCheckResult;
  usage: GeminiUsage;
}
export interface CombinedCallFailure {
  ok: false;
  reason: "parse_error" | "gemini_error";
  usage: GeminiUsage;
}
export type CombinedCallResult = CombinedCallSuccess | CombinedCallFailure;

export async function factCheckCombined(
  userPrompt: string,
  aiResponse: string,
  conversationHistory?: ReadonlyArray<ConversationTurn>
): Promise<CombinedCallResult> {
  const userMessage = buildFactCheckCombinedUserMessage(
    userPrompt,
    aiResponse,
    todayUtc(),
    conversationHistory
  );
  const call = await callGemini(null, `${FACT_CHECK_COMBINED_PROMPT}\n\n${userMessage}`, {
    withSearch: true,
    timeoutMs: COMBINED_TIMEOUT_MS,
    disableThinking: true,
    maxOutputTokens: 4096
  });
  if (!call.ok) {
    return { ok: false, reason: "gemini_error", usage: { tokens_in: 0, tokens_out: 0 } };
  }
  const parsed = parseCombinedResponse(call.text, aiResponse, call.groundingUrls);
  if (!parsed) return { ok: false, reason: "parse_error", usage: call.usage };
  return { ok: true, result: parsed, usage: call.usage };
}

export async function factCheckSelectionCombined(
  selectedText: string,
  contextBefore: string,
  contextAfter: string,
  originatingPrompt: string
): Promise<CombinedCallResult> {
  const userMessage = buildFactCheckSelectionCombinedUserMessage(
    selectedText,
    contextBefore,
    contextAfter,
    originatingPrompt,
    todayUtc()
  );
  const call = await callGemini(null, `${FACT_CHECK_SELECTION_COMBINED_PROMPT}\n\n${userMessage}`, {
    withSearch: true,
    timeoutMs: COMBINED_TIMEOUT_MS,
    disableThinking: true,
    maxOutputTokens: 4096
  });
  if (!call.ok) {
    return { ok: false, reason: "gemini_error", usage: { tokens_in: 0, tokens_out: 0 } };
  }
  const parsed = parseCombinedResponse(call.text, selectedText, call.groundingUrls);
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

export interface FactCheckVerifyInput {
  claim_text: string;
  claim_type: ClaimType;
  claim_subtype: ClaimSubtype;
  why_check?: string;
  today?: string; // YYYY-MM-DD; defaults to today (UTC)
}

export async function factCheckVerify(input: FactCheckVerifyInput): Promise<VerifierCallResult> {
  const userMessage = buildFactCheckVerifierUserMessage({
    claim_text: input.claim_text,
    claim_type: input.claim_type,
    claim_subtype: input.claim_subtype,
    why_check: input.why_check,
    today: input.today ?? todayUtc()
  });
  const call = await callGemini(FACT_CHECK_VERIFIER_PROMPT, userMessage, { withSearch: true, timeoutMs: VERIFY_TIMEOUT_MS });
  if (!call.ok) {
    return { ok: false, reason: "gemini_error", usage: { tokens_in: 0, tokens_out: 0 } };
  }
  const parsed = parseVerifierResponse(call.text);
  if (!parsed) return { ok: false, reason: "parse_error", usage: call.usage };
  return { ok: true, result: parsed, usage: call.usage };
}
