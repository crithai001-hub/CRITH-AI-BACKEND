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
  | { skip: false; validations: Validation[]; analysis_id: string }
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
  reason?: Extract<SkipReason, "trivial" | "code" | "factual">;
}

export interface ClaudeUsage {
  tokens_in: number;
  tokens_out: number;
  cached_tokens: number;
}
