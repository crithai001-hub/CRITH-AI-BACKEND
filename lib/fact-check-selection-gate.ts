// lib/fact-check-selection-gate.ts
import type { FactCheckSelectionGateResult } from "../types/index.js";

const MIN_LENGTH = 40;
const CODE_THRESHOLD = 0.85;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const URL_ONLY_RE = /^\s*https?:\/\/\S+\s*$/i;

function codeFenceFraction(text: string): number {
  if (text.length === 0) return 0;
  let codeChars = 0;
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    codeChars += match[0].length;
  }
  return codeChars / text.length;
}

// Order: URL-only → length/whitespace → code-dominated. First match wins.
// URL-only is checked first so a long bare URL gets pure_syntax not too_short.
export function evaluateFactCheckSelectionGate(
  selectedText: string
): FactCheckSelectionGateResult {
  if (URL_ONLY_RE.test(selectedText)) {
    return { skip: true, reason: "selection_pure_syntax" };
  }
  if (selectedText.length < MIN_LENGTH || !/\s/.test(selectedText)) {
    return { skip: true, reason: "selection_too_short" };
  }
  if (codeFenceFraction(selectedText) > CODE_THRESHOLD) {
    return { skip: true, reason: "selection_pure_syntax" };
  }
  return { skip: false };
}
