export type Platform = "chatgpt" | "claude" | "gemini";

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

export type EventType = "shown" | "expanded" | "sent_to_ai" | "dismissed" | "copied";

export interface AnalyzeRequestBody {
  prompt: string;
  response: string;
  platform: Platform;
  conversation_id: string;
  message_id: string;
}

export interface EventsRequestBody {
  analysis_id: string;
  provocation_index: number;
  event_type: EventType;
}

export interface Provocation {
  question: string;
  lens: Lens;
  anchored_to: string;
  severity: Severity;
}

export interface ClaudeAnalysisResult {
  skip: boolean;
  provocations: Provocation[];
}

export type AnalyzeResponse =
  | { skip: true; reason: SkipReason; analysis_id: string }
  | { skip: false; provocations: Provocation[]; analysis_id: string }
  | { error: "unauthorized" }
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
