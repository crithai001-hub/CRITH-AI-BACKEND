-- Crith AI V2 — conversation context migration
-- Adds two diagnostic columns to response_analyses so we can correlate
-- prompt v12's behavior with whether (and how much) prior-turn context was
-- supplied by the extension.

alter table public.response_analyses
  add column if not exists conversation_history_turn_count int not null default 0,
  add column if not exists conversation_history_chars      int not null default 0;

comment on column public.response_analyses.conversation_history_turn_count is
  'Number of prior turns included in the analyzer call (0-6). Diagnostic only.';
comment on column public.response_analyses.conversation_history_chars is
  'Total chars of conversation_history sent to the analyzer. Diagnostic only.';
