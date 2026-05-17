-- Crith AI V2 — flag-summary endpoint schema
-- Adds:
--   - response_analyses.summary_report (cached text) and .summary_report_version
--   - flag_summaries table (telemetry for /api/summarize-flags)
-- RLS pattern matches earlier migrations.

-- ============================================================================
-- response_analyses additions
-- ============================================================================
alter table public.response_analyses
  add column if not exists summary_report          text,
  add column if not exists summary_report_version  text;

comment on column public.response_analyses.summary_report is
  'Cached on-demand summary produced by /api/summarize-flags. Null until the user expands the report panel for this analysis.';
comment on column public.response_analyses.summary_report_version is
  'Prompt version of the summarizer when this report was generated. Lets us invalidate cached reports if the prompt evolves.';

-- ============================================================================
-- flag_summaries — one row per /api/summarize-flags invocation
-- ============================================================================
create table if not exists public.flag_summaries (
  id              uuid primary key default gen_random_uuid(),
  analysis_id     uuid not null references public.response_analyses(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  cache_hit       bool not null default false,
  tokens_in       int  not null default 0,
  tokens_out      int  not null default 0,
  cached_tokens   int  not null default 0,
  latency_ms      int  not null default 0,
  prompt_version  text not null,
  created_at      timestamptz not null default now()
);

create index if not exists flag_summaries_analysis_id_idx
  on public.flag_summaries (analysis_id);

create index if not exists flag_summaries_user_id_created_at_idx
  on public.flag_summaries (user_id, created_at desc);

alter table public.flag_summaries enable row level security;

create policy "users select own flag summaries"
  on public.flag_summaries for select
  using (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies for end users. Writes via service role.
