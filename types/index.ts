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

// Widened to include hallucination + sycophancy so the inline-pick lens
// priority covers every value the frontend ranks. The validator prompt does
// not currently emit hallucination (claim extractor's territory) or sycophancy
// (separate prompt, not yet implemented), but the type completeness keeps the
// server-side inline-pick honest and matches the frontend's enum exactly.
export type Lens =
  | "hallucination"
  | "sycophancy"
  | "confidence_evidence_gap"
  | "hidden_assumption"
  | "missing_angle"
  | "question_mismatch";

export type Severity = "high" | "medium" | "low";

export type SkipReason =
  | "trivial"
  | "code"
  | "factual"
  | "deterministic_task"
  | "parse_error"
  | "quota_exceeded"
  | "claude_error"
  | "ask_too_short"
  | "ask_no_substance"
  | "ask_pure_syntax";

export type AnalysisKind = "response_analysis" | "ask_crith";

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

export interface AskCrithRequestBody {
  selected_text: string;
  context_before: string;
  context_after: string;
  prompt: string;
  platform: Platform;
  conversation_id: string;
  message_id: string;
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

// v25+: flat enriched flag shape returned in the new `flags[]` array. Same
// underlying content as a Validation, plus stable id, analysis_id, an index
// into the flat array, and a tier marker so the extension can group panel
// entries without needing a second array. The extension keys host dedup by
// provocation_id — refires of the same logical flag (same lens + anchored_to)
// return the same id so old hosts stay put instead of tearing down.
export type FlagTier = "inline" | "suppressed";

export interface Flag {
  provocation_id: string;
  analysis_id: string;
  provocation_index: number;
  problem: string;
  follow_up_prompt: string;
  lens: Lens;
  anchored_to: string;
  severity: Severity;
  tier: FlagTier;
}

export interface ClaudeAnalysisResult {
  skip: boolean;
  validations: Validation[];
  // v24+: broader findings that passed the validator's quality gates but not
  // the severity/direct-relevance bar. Rendered in the report panel only.
  suppressed: Validation[];
}

export type AnalyzeResponse =
  | { skip: true; reason: SkipReason; analysis_id: string }
  | {
      skip: false;
      // Legacy v24 fields. Kept populated for older extensions; new clients
      // should read `flags` and `verifiable_claims` (now enriched) instead.
      validations: Validation[];
      suppressed: Validation[];
      // v25+ wire shape — flat, enriched, server-curated.
      flags: Flag[];
      inline_flag_id: string | null;
      verifiable_claims: EnrichedVerifiableClaim[];
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

export interface SummarizeFlagsRequestBody {
  analysis_id: string;
}

export type SummarizeFlagsResponse =
  | { summary: string; cache_hit: boolean }
  | { error: "unauthorized" }
  | { error: "not_found" }
  | { error: "not_applicable"; message: string }
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

export interface AskCrithTriggerGateResult {
  skip: boolean;
  reason?: Extract<SkipReason, "ask_too_short" | "ask_pure_syntax">;
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
  | "ai_mistake"
  | "actionable_recommendation";

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

// v25+: enriched claim shape returned on the wire. claim_text is an alias for
// claim (kept on the raw VerifiableClaim for backward compat); verify is the
// server-decided gate the extension trusts to decide whether to fire
// /api/verify-claim.
export interface EnrichedVerifiableClaim extends VerifiableClaim {
  claim_id: string;
  claim_index: number;
  analysis_id: string;
  claim_text: string;
  verify: boolean;
  // Inline-verification fields. Populated only when ask-crith ran the verifier
  // inline. When absent, the frontend may call /api/verify-claim to fetch.
  verdict?: Verdict;
  evidence?: string;
  source_urls?: string[];
  verification_id?: string;
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
      // v25+ alias of evidence_summary. Both are returned with the same value;
      // new clients should read `evidence`, old clients keep reading
      // `evidence_summary`.
      evidence: string;
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
