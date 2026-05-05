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

export type Lens =
  | "missing_angle"
  | "hidden_assumption"
  | "confidence_evidence_gap"
  | "question_mismatch";

export type Severity = "high" | "medium" | "low";

export type SkipReason =
  | "trivial"
  | "code"
  | "factual"
  | "deterministic_task"
  | "parse_error"
  | "quota_exceeded"
  | "claude_error";

export type EventType =
  | "shown"
  | "expanded"
  | "sent_to_ai"
  | "dismissed"
  | "copied"
  | "explained"
  | "useful"
  | "not_useful"
  | "asked_ai";

export interface AnalyzeRequestBody {
  prompt: string;
  response: string;
  platform: Platform;
  conversation_id: string;
  message_id: string;
  conversation_history?: ConversationTurn[];
}

export interface ExplainRequestBody {
  analysis_id: string;
  provocation_index: number;
}

export interface EventsRequestBody {
  analysis_id: string;
  provocation_index: number;
  event_type: EventType;
}

// Legacy v12/v13 output shape. Kept because pre-v14 response_analyses rows
// store this in the `provocations` column and the explainer endpoint still
// reads them. New rows under v14+ store Validation in the `validations`
// column instead.
export interface Provocation {
  question: string;
  lens: Lens;
  anchored_to: string;
  severity: Severity;
}

// v14+ output shape. `problem` is a declarative statement of what the AI did
// wrong; `follow_up_prompt` is a ready-to-send first-person prompt the user
// fires back at the AI in one tap.
export interface Validation {
  problem: string;
  follow_up_prompt: string;
  lens: Lens;
  anchored_to: string;
  severity: Severity;
}

export interface ClaudeAnalysisResult {
  skip: boolean;
  validations: Validation[];
}

export type AnalyzeResponse =
  | { skip: true; reason: SkipReason; analysis_id: string }
  | {
      skip: false;
      validations: Validation[];
      verifiable_claims: VerifiableClaim[];
      analysis_id: string;
      prompt_versions: PromptVersions;
    }
  | { error: "unauthorized" }
  | { error: "quota_exceeded"; limit: number; used: number }
  | { error: "internal" }
  | { error: "bad_request"; message: string };

export type ExplainResponse =
  | { explanation: string }
  | { error: "unauthorized" }
  | { error: "not_found" }
  | { error: "quota_exceeded"; limit: number; used: number }
  | { error: "internal" }
  | { error: "bad_request"; message: string };

export type EventsResponse =
  | { ok: true }
  | { error: "unauthorized" }
  | { error: "forbidden" }
  | { error: "bad_request"; message: string }
  | { error: "internal" };

export interface TriggerGateResult {
  skip: boolean;
  reason?: Extract<SkipReason, "trivial" | "code" | "factual" | "deterministic_task">;
}

export interface ClaudeUsage {
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
}

// Claim extractor (parallel to validator). Output of prompts/claim-extractor-prompt.ts.
export type ClaimType =
  | "statistic"
  | "citation"
  | "person_or_role"
  | "date"
  | "product_or_pricing"
  | "current_state"
  | "quote"
  | "technical_fact"
  | "generation_artifact";

export type Risk = "high" | "medium" | "low";

// Claude's read on whether the claim looks like a fabrication or stale fact.
// Independent from `risk` (which is about consequences if false). The frontend
// underlines "high" and "medium" claims so the user is warned before clicking
// through to verification; "none" claims ship for on-demand verify only.
export type HallucinationSignal = "high" | "medium" | "none";

export interface VerifiableClaim {
  claim: string;
  anchored_to: string;
  claim_type: ClaimType;
  why_verify: string;
  risk: Risk;
  hallucination_signal: HallucinationSignal;
  hallucination_reason: string;
}

export interface ClaimExtractorResult {
  skip: boolean;
  verifiable_claims: VerifiableClaim[];
}

// Verify endpoint.
export type Verdict = "confirmed" | "contradicted" | "inconclusive" | "error";

export interface VerifyRequestBody {
  analysis_id: string;
  claim_index: number;
}

export type VerifyResponse =
  | {
      verdict: Verdict;
      evidence_summary: string;
      source_urls: string[];
      verification_id: string;
    }
  | { error: "unauthorized" }
  | { error: "not_found" }
  | { error: "quota_exceeded"; limit: number; used: number }
  | { error: "internal" }
  | { error: "bad_request"; message: string };

// Brave Search client.
export interface BraveSearchResult {
  title: string;
  snippet: string;
  url: string;
}

// Augmented analyze response — additive only; old extension code stays compatible.
export interface PromptVersions {
  validator: string;
  claim_extractor: string;
}
