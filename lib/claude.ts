import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildUserMessage } from "../prompts/system-prompt.js";
import type {
  ClaudeAnalysisResult,
  ClaudeUsage,
  ConversationTurn,
  Provocation
} from "../types/index.js";

// Lazy client — env var is read on first use, not at module import time.
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
const TEMPERATURE = 0.3;

// Rough char-based estimator. 1 token ≈ 4 chars. 3000 tokens ≈ 12000 chars.
const MAX_RESPONSE_CHARS = 12000;
const TRUNCATION_MARKER = "\n\n[...truncated...]";

const RETRY_REMINDER =
  "\n\nIMPORTANT: Return ONLY a JSON object. No preamble, no markdown fences, no explanation.";

const VALID_LENSES = new Set([
  "missing_angle",
  "hidden_assumption",
  "confidence_evidence_gap",
  "question_mismatch"
]);
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);

export function truncateResponse(response: string): string {
  if (response.length <= MAX_RESPONSE_CHARS) return response;
  return response.slice(0, MAX_RESPONSE_CHARS) + TRUNCATION_MARKER;
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

function validateAnalysis(
  parsed: unknown,
  aiResponse: string
): ClaudeAnalysisResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.skip !== "boolean") return null;
  if (!Array.isArray(obj.provocations)) return null;

  if (obj.skip && obj.provocations.length > 0) {
    return { skip: true, provocations: [] };
  }

  const provocations: Provocation[] = [];
  for (const raw of obj.provocations) {
    if (!raw || typeof raw !== "object") return null;
    const p = raw as Record<string, unknown>;
    if (
      typeof p.question !== "string" ||
      typeof p.lens !== "string" ||
      typeof p.anchored_to !== "string" ||
      typeof p.severity !== "string"
    ) {
      return null;
    }
    if (!VALID_LENSES.has(p.lens) || !VALID_SEVERITIES.has(p.severity)) return null;

    // Anchor MUST be a verbatim substring of the response. The extension renders
    // each underline by calling response.includes(anchored_to); if that returns
    // false the provocation silently has no UI anchor. Drop the bad ones here
    // so the extension never sees them. Logged for prompt-quality monitoring —
    // a high drop rate means the model is paraphrasing despite the prompt rule.
    if (!aiResponse.includes(p.anchored_to)) {
      console.warn("[claude] dropping provocation with non-verbatim anchor", {
        lens: p.lens,
        anchored_to_preview: p.anchored_to.slice(0, 120)
      });
      continue;
    }

    provocations.push({
      question: p.question,
      lens: p.lens as Provocation["lens"],
      anchored_to: p.anchored_to,
      severity: p.severity as Provocation["severity"]
    });
  }

  return { skip: obj.skip, provocations };
}

interface ClaudeCallSuccess {
  ok: true;
  result: ClaudeAnalysisResult;
  usage: ClaudeUsage;
}

interface ClaudeCallParseFailure {
  ok: false;
  reason: "parse_error";
  usage: ClaudeUsage;
}

export type ClaudeCallResult = ClaudeCallSuccess | ClaudeCallParseFailure;

async function callOnce(userMessage: string, extraSystemSuffix: string): Promise<{
  text: string;
  usage: ClaudeUsage;
}> {
  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT + extraSystemSuffix,
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

export async function analyzeResponse(
  userPrompt: string,
  aiResponse: string,
  conversationHistory?: ReadonlyArray<ConversationTurn>
): Promise<ClaudeCallResult> {
  // Truncate once and reuse — both the model and the anchor validator must see
  // the same string, otherwise an anchor that exists in the full response but
  // got cut by truncation would be wrongly dropped (or vice versa).
  const truncated = truncateResponse(aiResponse);
  const userMessage = buildUserMessage(userPrompt, truncated, conversationHistory);

  // First attempt — clean system prompt, prompt cache eligible.
  const first = await callOnce(userMessage, "");
  const firstJson = extractFirstJsonBlock(first.text);
  if (firstJson) {
    try {
      const parsed = JSON.parse(firstJson);
      const validated = validateAnalysis(parsed, truncated);
      if (validated) return { ok: true, result: validated, usage: first.usage };
    } catch {
      // fall through to retry
    }
  }

  // Retry once with reminder appended. This invalidates the cache (different
  // system bytes), but only on the parse-error path — acceptable.
  const second = await callOnce(userMessage, RETRY_REMINDER);
  const totalUsage: ClaudeUsage = {
    tokens_in: first.usage.tokens_in + second.usage.tokens_in,
    tokens_out: first.usage.tokens_out + second.usage.tokens_out,
    cached_tokens: first.usage.cached_tokens + second.usage.cached_tokens
  };

  const secondJson = extractFirstJsonBlock(second.text);
  if (secondJson) {
    try {
      const parsed = JSON.parse(secondJson);
      const validated = validateAnalysis(parsed, truncated);
      if (validated) return { ok: true, result: validated, usage: totalUsage };
    } catch {
      // fall through to parse_error
    }
  }

  return { ok: false, reason: "parse_error", usage: totalUsage };
}
