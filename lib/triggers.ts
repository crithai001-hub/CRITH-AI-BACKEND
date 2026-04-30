import type { TriggerGateResult } from "../types/index.js";

const WORD_COUNT_THRESHOLD = 80;
const CODE_THRESHOLD = 0.85;
const FACTUAL_PROMPT_WORD_LIMIT = 8;

const FACTUAL_PREFIX_RE =
  /^(what is|what's|who is|who's|define|convert|translate)\b/i;
const ARITHMETIC_RE = /^\s*[\d+\-*/=().\s]+\??\s*$/;
const CODE_FENCE_RE = /```[\s\S]*?```/g;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function codeFenceFraction(text: string): number {
  if (text.length === 0) return 0;
  let codeChars = 0;
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    codeChars += match[0].length;
  }
  return codeChars / text.length;
}

export function isFactualLookup(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;

  const wordCount = countWords(trimmed);
  if (wordCount >= FACTUAL_PROMPT_WORD_LIMIT) return false;

  const questionMarks = (trimmed.match(/\?/g) ?? []).length;

  if (ARITHMETIC_RE.test(trimmed) && questionMarks <= 1) return true;

  if (questionMarks !== 1) return false;
  return FACTUAL_PREFIX_RE.test(trimmed);
}

// Pure trigger gate. Order: word count → code → factual. First match wins.
export function evaluateTriggerGate(prompt: string, response: string): TriggerGateResult {
  if (countWords(response) < WORD_COUNT_THRESHOLD) {
    return { skip: true, reason: "trivial" };
  }
  if (codeFenceFraction(response) > CODE_THRESHOLD) {
    return { skip: true, reason: "code" };
  }
  if (isFactualLookup(prompt)) {
    return { skip: true, reason: "factual" };
  }
  return { skip: false };
}
