import Anthropic from "@anthropic-ai/sdk";
import {
  EXPLAINER_SYSTEM_PROMPT,
  buildExplainerUserMessage
} from "../prompts/explainer-system-prompt.js";
import type { ClaudeUsage, Provocation } from "../types/index.js";

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
const MAX_TOKENS = 256;
const TEMPERATURE = 0.4;

interface ExplainerSuccess {
  ok: true;
  explanation: string;
  usage: ClaudeUsage;
}
interface ExplainerEmpty {
  ok: false;
  reason: "empty_response";
  usage: ClaudeUsage;
}
export type ExplainerResult = ExplainerSuccess | ExplainerEmpty;

export async function explainProvocation(
  originalPrompt: string,
  originalResponse: string,
  provocation: Pick<Provocation, "question" | "lens" | "anchored_to">
): Promise<ExplainerResult> {
  const userMessage = buildExplainerUserMessage(originalPrompt, originalResponse, provocation);

  const message = await getAnthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      {
        type: "text",
        text: EXPLAINER_SYSTEM_PROMPT,
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
  return { ok: true, explanation: text, usage };
}
