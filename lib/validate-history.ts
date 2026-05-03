import type { ConversationTurn } from "../types/index.js";

const MAX_TURNS = 6;
const MAX_CONTENT_CHARS = 1500;
const TRUNCATION_SUFFIX = "[...]";

export interface ValidatedHistory {
  cleaned: ConversationTurn[];
  turn_count: number;
  char_count: number;
}

// Defensive validator. The extension is the source of conversation_history,
// so all input is untrusted. Strategy: drop bad entries silently, truncate
// long entries, cap total turns. Never throw — a bad history shouldn't fail
// the analyze call, just degrade gracefully to less context.
export function validateConversationHistory(raw: unknown): ValidatedHistory {
  if (!Array.isArray(raw)) {
    return { cleaned: [], turn_count: 0, char_count: 0 };
  }

  // Keep only the most recent MAX_TURNS entries — if the extension sends 20
  // turns we want the latest 6, not the oldest.
  const sliced = raw.slice(-MAX_TURNS);
  const droppedByCap = raw.length - sliced.length;

  const cleaned: ConversationTurn[] = [];
  let truncatedAny = false;
  let droppedByValidation = 0;

  for (const entry of sliced) {
    if (!entry || typeof entry !== "object") {
      droppedByValidation++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.role !== "user" && e.role !== "assistant") {
      droppedByValidation++;
      continue;
    }
    if (typeof e.content !== "string" || e.content.length === 0) {
      droppedByValidation++;
      continue;
    }

    let content = e.content;
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
      truncatedAny = true;
    }
    cleaned.push({ role: e.role, content });
  }

  if (droppedByCap > 0 || droppedByValidation > 0 || truncatedAny) {
    console.warn("[validate-history] cleaned conversation_history", {
      received: raw.length,
      kept: cleaned.length,
      dropped_by_cap: droppedByCap,
      dropped_by_validation: droppedByValidation,
      truncated_content: truncatedAny
    });
  }

  const char_count = cleaned.reduce((sum, t) => sum + t.content.length, 0);
  return { cleaned, turn_count: cleaned.length, char_count };
}
