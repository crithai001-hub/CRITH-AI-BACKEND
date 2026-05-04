import Anthropic from "@anthropic-ai/sdk";
import {
  VERIFIER_PROMPT,
  buildVerifierUserMessage
} from "../prompts/verifier-prompt.js";
import type { BraveSearchResult, ClaudeUsage, Verdict } from "../types/index.js";

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
const MAX_TOKENS = 512;
const TEMPERATURE = 0.1;

const VALID_VERDICTS = new Set<Verdict>([
  "confirmed",
  "contradicted",
  "inconclusive",
  "error"
]);

export interface ParsedVerifierResult {
  verdict: Verdict;
  evidence_summary: string;
  source_urls: string[];
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

export function parseVerifierResponse(rawText: string): ParsedVerifierResult | null {
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
  if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict as Verdict)) return null;
  if (typeof obj.evidence_summary !== "string") return null;
  if (!Array.isArray(obj.source_urls)) return null;
  const source_urls = obj.source_urls.filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );
  return {
    verdict: obj.verdict as Verdict,
    evidence_summary: obj.evidence_summary,
    source_urls
  };
}

export interface VerifierSuccess {
  ok: true;
  result: ParsedVerifierResult;
  usage: ClaudeUsage;
}
export interface VerifierFailure {
  ok: false;
  reason: "parse_error";
  usage: ClaudeUsage;
}
export type VerifierCallResult = VerifierSuccess | VerifierFailure;

export async function verifyClaim(
  claim: string,
  searchResults: ReadonlyArray<BraveSearchResult>
): Promise<VerifierCallResult> {
  const userMessage = buildVerifierUserMessage(claim, searchResults);

  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: VERIFIER_PROMPT,
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

  const parsed = parseVerifierResponse(text);
  if (!parsed) return { ok: false, reason: "parse_error", usage };
  return { ok: true, result: parsed, usage };
}
