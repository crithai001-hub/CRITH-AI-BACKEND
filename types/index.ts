// types/index.ts — fact-checker MVP

export type Platform =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "perplexity"
  | "grok"
  | "deepseek";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// Fact-checker — claim taxonomy.
export type ClaimType = "citation" | "quote" | "statistic" | "factual";

// Verdict labels — honest, evidence-state framing.
// Default is "could_not_verify". The verifier prompt is instructed never to
// assert truth in absence of recent supporting sources.
export type Verdict =
  | "found_supporting"
  | "found_contradicting"
  | "could_not_verify"
  | "error";

// Skip reasons surfaced by the trigger gates or by post-extraction outcomes.
// extracted_nothing is a normal outcome on /api/fact-check when the response
// has nothing falsifiable — it is NOT an error.
export type SkipReason =
  | "trivial"
  | "code"
  | "factual_lookup"
  | "extracted_nothing"
  | "selection_too_short"
  | "selection_pure_syntax"
  | "parse_error"
  | "gemini_error";

export type AnalysisKind = "fact_check" | "fact_check_selection";

// Wire shape for a single extracted claim.
export interface Claim {
  claim_id: string;
  claim_index: number;
  analysis_id: string;
  claim_text: string;       // clean, searchable restatement
  anchored_to: string;      // verbatim 30-80 char substring of response/selection
  claim_type: ClaimType;
  why_check: string;        // names the specific falsifiable element
}

// ---- Requests ----

export interface FactCheckRequestBody {
  prompt: string;
  response: string;
  platform: Platform;
  conversation_id: string;
  message_id: string;
  conversation_history?: ConversationTurn[];
}

export interface FactCheckSelectionRequestBody {
  selected_text: string;
  context_before: string;
  context_after: string;
  prompt: string;
  platform: Platform;
  conversation_id: string;
  message_id: string;
}

export interface VerifyRequestBody {
  analysis_id: string;
  claim_index: number;
}

// ---- Responses ----

export type FactCheckResponse =
  | {
      skip: false;
      analysis_id: string;
      claims: Claim[];
      prompt_version: string;
    }
  | { skip: true; reason: SkipReason; analysis_id: string }
  | { error: "unauthorized" }
  | { error: "internal" }
  | { error: "bad_request"; message: string };

export type VerifyResponse =
  | {
      verdict: Verdict;
      evidence: string;
      source_urls: string[];
      as_of_date: string;
      was_true_until?: string;
      verification_id: string;
      follow_up_prompt: string;
    }
  | { error: "unauthorized" }
  | { error: "not_found" }
  | { error: "quota_exceeded"; limit: number; used: number }
  | { error: "internal" }
  | { error: "bad_request"; message: string };

// ---- Gate results ----

export interface FactCheckGateResult {
  skip: boolean;
  reason?: Extract<SkipReason, "trivial" | "code" | "factual_lookup">;
}

export interface FactCheckSelectionGateResult {
  skip: boolean;
  reason?: Extract<SkipReason, "selection_too_short" | "selection_pure_syntax">;
}

// ---- Gemini usage telemetry ----

export interface GeminiUsage {
  tokens_in: number;
  tokens_out: number;
}

// ---- Internal extractor/verifier shapes (pre-enrichment) ----

export interface RawExtractedClaim {
  claim_text: string;
  anchored_to: string;
  claim_type: ClaimType;
  why_check: string;
}

export interface ExtractorResult {
  skip: boolean;
  claims: RawExtractedClaim[];
}

// was_true_until uses the same optional encoding as VerifyResponse so the
// internal-to-wire mapping in /api/verify-claim is a direct field copy with no
// nullable-to-optional conversion.
export interface VerifierResult {
  verdict: Verdict;
  evidence: string;
  source_urls: string[];
  as_of_date: string;
  was_true_until?: string;
  follow_up_prompt: string;
}
