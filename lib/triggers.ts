import type { TriggerGateResult } from "../types/index.js";

const WORD_COUNT_THRESHOLD = 80;
const CODE_THRESHOLD = 0.85;
const FACTUAL_PROMPT_WORD_LIMIT = 8;
const DIGIT_HEAVY_THRESHOLD = 0.08;

const FACTUAL_PREFIX_RE =
  /^(what is|what's|who is|who's|define|convert|translate)\b/i;
const ARITHMETIC_RE = /^\s*[\d+\-*/=().\s]+\??\s*$/;
const CODE_FENCE_RE = /```[\s\S]*?```/g;

// Math operators in numeric context: digit op digit, math symbols, LaTeX,
// or a variable raised to a power (x^2, y², n³).
const MATH_OPERATORS_IN_CONTEXT_RE =
  /\d\s*[+\-*/=^×÷%]\s*\d|[√∑∫≈≤≥]|\\(?:sqrt|frac|sum|int|times|div)|\b[a-zA-Z]\s*[\^]\s*\d|\b[a-zA-Z][²³⁴⁵]/u;

// Computational verb at the start of the prompt (imperative position).
const COMPUTATIONAL_VERB_RE =
  /^\s*(?:solve|calculate|compute|evaluate|simplify|derive|differentiate|integrate|factor|expand|round|estimate|multiply|divide|subtract|convert)\b/i;

// Specific computational phrases regardless of position.
const COMPUTATIONAL_PHRASE_RE =
  /\b(?:square root|cube root|find the (?:value|root|derivative|integral|area|volume|product|sum|difference|quotient)|how many [^?]*?(?:are|is) (?:in|equal))/i;

// Patterns used to decide if the RESPONSE is dominated by math/calculation
// content. Any of these alone is treated as a strong signal.
const EQUATION_PATTERN_RE = /\b[a-zA-Z0-9_()]+\s*=\s*[^=\s]/g;
const MATH_UNICODE_RE = /[√∑∫≈≤≥×÷±∞]/g;
const OP_DIGIT_PATTERN_RE = /\d+\s*[+\-*/=^×÷]\s*\d+/g;

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

export function digitFraction(s: string): number {
  if (s.length === 0) return 0;
  let count = 0;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") count++;
  }
  return count / s.length;
}

// Counts patterns in the response that indicate it is dominated by math.
// Any one of the three sub-detectors hitting its threshold makes the response
// "math-heavy" and is a strong stand-alone signal in isDeterministicTask.
export function isResponseMathHeavy(response: string): boolean {
  if (response.length === 0) return false;
  const equationCount = (response.match(EQUATION_PATTERN_RE) ?? []).length;
  if (equationCount >= 3) return true;
  const mathSymbolCount = (response.match(MATH_UNICODE_RE) ?? []).length;
  if (mathSymbolCount >= 5) return true;
  const opDigitCount = (response.match(OP_DIGIT_PATTERN_RE) ?? []).length;
  if (opDigitCount >= 5) return true;
  return false;
}

// Detects prompts where the user wants ONE correct answer that the AI can
// either compute or look up — math, conversions, "solve this," etc.
// Provocations are pointless on these: there's no reasoning to question,
// just a computation to verify.
//
// Two paths:
//   (a) Strong signal: response is itself math-heavy (3+ equations, 5+ math
//       symbols, or 5+ digit-op-digit patterns). One signal is enough — if
//       the AI's response is dominated by calculation, the prompt context
//       doesn't matter, there's no reasoning to question.
//   (b) Weak signals (at-least-2): math operators in prompt, computational
//       verb at start, digit-heavy prompt, digit-heavy response. Guards
//       against false positives like "Should I use Newton's method to solve
//       this?" (strategy question containing 'solve' but no operators).
export function isDeterministicTask(prompt: string, response: string): boolean {
  if (isResponseMathHeavy(response)) return true;

  let signals = 0;
  if (MATH_OPERATORS_IN_CONTEXT_RE.test(prompt)) signals++;
  if (COMPUTATIONAL_VERB_RE.test(prompt) || COMPUTATIONAL_PHRASE_RE.test(prompt)) signals++;
  if (digitFraction(prompt) > DIGIT_HEAVY_THRESHOLD) signals++;
  if (digitFraction(response) > DIGIT_HEAVY_THRESHOLD) signals++;
  return signals >= 2;
}

// Pure trigger gate. Order: word count → code → factual → deterministic.
// First match wins.
//
// hasContext (v13+): when the request includes prior conversation turns, the
// trivial word-count check is skipped. Short follow-ups in real conversations
// ("what about X?" → "Try Y") are exactly the case where context-aware analysis
// matters most; gating them out by current-turn length defeats the purpose.
// Code, factual, and deterministic checks still run — they're about the
// current turn's *type* and shouldn't be bypassed by prior context.
export function evaluateTriggerGate(
  prompt: string,
  response: string,
  hasContext = false
): TriggerGateResult {
  if (!hasContext && countWords(response) < WORD_COUNT_THRESHOLD) {
    return { skip: true, reason: "trivial" };
  }
  if (codeFenceFraction(response) > CODE_THRESHOLD) {
    return { skip: true, reason: "code" };
  }
  if (isFactualLookup(prompt)) {
    return { skip: true, reason: "factual" };
  }
  if (isDeterministicTask(prompt, response)) {
    return { skip: true, reason: "deterministic_task" };
  }
  return { skip: false };
}
