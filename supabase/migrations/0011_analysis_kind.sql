-- Crith AI V2 — add analysis_kind to response_analyses
-- Distinguishes rows produced by the automatic /api/analyze-response endpoint
-- ('response_analysis', the existing default) from rows produced by the
-- user-initiated /api/ask-crith endpoint ('ask_crith'). The two endpoints
-- share the same table because /api/verify-claim and /api/events look up by
-- analysis_id and don't need to care which produced the row.
--
-- ask_context_before / ask_context_after carry the 0..200 char context blobs
-- the ask-crith endpoint receives alongside selected_text. Nullable because
-- only ask-crith rows populate them.

alter table public.response_analyses
  add column if not exists analysis_kind text not null default 'response_analysis',
  add column if not exists ask_context_before text,
  add column if not exists ask_context_after text;

alter table public.response_analyses
  add constraint response_analyses_kind_check
  check (analysis_kind in ('response_analysis', 'ask_crith'));

create index if not exists response_analyses_analysis_kind_idx
  on public.response_analyses (analysis_kind, created_at desc);
