import { codeFenceFraction } from "./triggers.js";
import type { AskCrithTriggerGateResult } from "../types/index.js";

const MIN_LENGTH = 40;
const CODE_THRESHOLD = 0.85;

const URL_ONLY_RE = /^\s*https?:\/\/\S+\s*$/i;

// Greeting tokens — any selection composed entirely of these (case-insensitive,
// any whitespace, any repetition) is a non-substantive selection. Add new
// tokens here over time as we see false-positive asks in logs.
const GREETING_TOKENS = new Set([
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank",
  "you",
  "ok",
  "okay",
  "cool",
  "nice",
  "sure",
  "yep",
  "yes",
  "no",
  "bye"
]);

function isGreetingOnly(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((t) => GREETING_TOKENS.has(t));
}

// Selection-aware skip gate for /api/ask-crith.
// Order: URL-only → length/whitespace → code-dominated → greeting. First match wins.
// URL-only is checked before length/whitespace so a long bare URL gets ask_pure_syntax
// rather than ask_too_short.
//
// Unlike analyze-response, we do NOT reuse the deterministic-task / factual
// checks — the user explicitly opted in by clicking "Ask CRITH" on this
// specific selection, so we trust their intent.
export function evaluateAskCrithGate(selectedText: string): AskCrithTriggerGateResult {
  if (URL_ONLY_RE.test(selectedText)) {
    return { skip: true, reason: "ask_pure_syntax" };
  }
  if (selectedText.length < MIN_LENGTH || !/\s/.test(selectedText)) {
    return { skip: true, reason: "ask_too_short" };
  }
  if (codeFenceFraction(selectedText) > CODE_THRESHOLD) {
    return { skip: true, reason: "ask_pure_syntax" };
  }
  if (isGreetingOnly(selectedText)) {
    return { skip: true, reason: "ask_pure_syntax" };
  }
  return { skip: false };
}
