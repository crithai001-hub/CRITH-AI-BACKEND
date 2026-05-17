import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildUserMessage } from "../prompts/system-prompt.js";
import { recoverAnchor } from "./anchor.js";
import type {
  ClaudeAnalysisResult,
  ClaudeUsage,
  ConversationTurn,
  Validation
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

// Hard caps mirror the system prompt's stated limits. The model is told these
// in plain English; the validator enforces them so a runaway sentence can't
// blow out the card UI.
//
// v15: relaxed from 220/350 after field testing showed the model consistently
// produced 226-286 char problem statements (good content, just over). Bumping
// to 300/450 keeps the "reads in 5 seconds" feel while letting natural prose
// through. Drop rate dropped from ~80% to near zero on the same fixtures.
const PROBLEM_MAX_CHARS = 300;
const FOLLOW_UP_MAX_CHARS = 450;

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

// Hard cap on suppressed list. Mirrors the prompt's "max 4" guidance and
// prevents a runaway model from filling the report panel with noise.
const SUPPRESSED_MAX = 4;

// Per-item validator shared by both `validations` and `suppressed`. Returns
// null for whole-batch failures (missing required field, invalid enum) and a
// Validation when the row should be kept. Soft drops are logged with a
// bucket label so we can tell from logs which list a drop came from.
function validateSingle(
  raw: unknown,
  aiResponse: string,
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
    console.warn(`[claude] dropping ${bucket} item: problem length out of range`, {
      length: v.problem.length,
      cap: PROBLEM_MAX_CHARS,
      lens: v.lens
    });
    return null;
  }

  if (v.follow_up_prompt.length === 0 || v.follow_up_prompt.length > FOLLOW_UP_MAX_CHARS) {
    console.warn(`[claude] dropping ${bucket} item: follow_up_prompt length out of range`, {
      length: v.follow_up_prompt.length,
      cap: FOLLOW_UP_MAX_CHARS,
      lens: v.lens
    });
    return null;
  }

  const recovered = recoverAnchor(v.anchored_to, aiResponse);
  if (recovered === null) {
    console.warn(`[claude] dropping ${bucket} item: anchor not recoverable`, {
      lens: v.lens,
      anchored_to_preview: v.anchored_to.slice(0, 120)
    });
    return null;
  }
  if (recovered !== v.anchored_to) {
    console.info(`[claude] ${bucket} anchor recovered`, {
      lens: v.lens,
      original_preview: v.anchored_to.slice(0, 120),
      recovered_preview: recovered.slice(0, 120)
    });
  }

  return {
    problem: v.problem,
    follow_up_prompt: v.follow_up_prompt,
    lens: v.lens as Validation["lens"],
    anchored_to: recovered,
    severity: v.severity as Validation["severity"]
  };
}

function validateAnalysis(
  parsed: unknown,
  aiResponse: string
): ClaudeAnalysisResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.skip !== "boolean") return null;
  if (!Array.isArray(obj.validations)) return null;

  // suppressed is OPTIONAL — older prompt outputs and degenerate model outputs
  // may omit it. Treat absence as empty.
  const rawSuppressed = Array.isArray(obj.suppressed) ? obj.suppressed : [];

  // Skip-true with content is a model contract violation; keep skip semantic
  // and discard everything else rather than reject the whole batch.
  if (obj.skip) {
    return { skip: true, validations: [], suppressed: [] };
  }

  const validations: Validation[] = [];
  for (const raw of obj.validations) {
    const v = validateSingle(raw, aiResponse, "validations");
    if (v === null) {
      // Distinguish hard-fail (bad shape / enum) from soft-drop (length / anchor).
      // validateSingle returns null in BOTH cases; on a shape/enum failure we
      // want to fail the whole batch (the model isn't following the contract);
      // on a soft drop we just skip the item. We can't tell them apart from
      // here without re-inspecting, so be conservative and fail only when the
      // raw item is non-object-shaped or missing required string fields.
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
    const v = validateSingle(raw, aiResponse, "suppressed");
    if (v !== null) suppressed.push(v);
    // suppressed never fails the whole batch — it's optional report-panel content.
  }

  return { skip: obj.skip, validations, suppressed };
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
