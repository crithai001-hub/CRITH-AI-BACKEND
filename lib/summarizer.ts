import Anthropic from "@anthropic-ai/sdk";
import {
  SUMMARY_REPORT_SYSTEM_PROMPT,
  buildSummaryReportUserMessage
} from "../prompts/summary-report-prompt.js";
import type { ClaudeUsage, Validation } from "../types/index.js";

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
const MAX_TOKENS = 384;
const TEMPERATURE = 0.4;
const SUMMARY_MAX_CHARS = 700;

interface SummarizerSuccess {
  ok: true;
  summary: string;
  usage: ClaudeUsage;
}
interface SummarizerEmpty {
  ok: false;
  reason: "empty_response";
  usage: ClaudeUsage;
}
export type SummarizerResult = SummarizerSuccess | SummarizerEmpty;

export async function summarizeFlags(
  originalPrompt: string,
  originalResponse: string,
  validations: ReadonlyArray<Validation>
): Promise<SummarizerResult> {
  const userMessage = buildSummaryReportUserMessage(
    originalPrompt,
    originalResponse,
    validations
  );

  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: SUMMARY_REPORT_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: userMessage }]
  });

  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  text = text.trim();

  const usage: ClaudeUsage = {
    tokens_in: message.usage.input_tokens,
    tokens_out: message.usage.output_tokens,
    cached_tokens: message.usage.cache_read_input_tokens ?? 0
  };

  if (!text) return { ok: false, reason: "empty_response", usage };

  // Soft cap. The prompt asks for ≤500 chars; if the model goes over, trim at
  // a sentence boundary so the UI still gets clean prose.
  const trimmed =
    text.length <= SUMMARY_MAX_CHARS
      ? text
      : trimAtSentenceBoundary(text, SUMMARY_MAX_CHARS);

  return { ok: true, summary: trimmed, usage };
}

function trimAtSentenceBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! ")
  );
  if (lastSentenceEnd > 0) return slice.slice(0, lastSentenceEnd + 1);
  return slice;
}
