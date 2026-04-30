-- Crith AI V2 — initial schema
-- Tables: response_analyses, provocation_events, user_usage
-- View:   provocation_engagement_with_email
-- RLS:    users can SELECT/UPDATE their own rows; INSERTs happen via service role from API code.

create extension if not exists "pgcrypto";

-- ============================================================================
-- response_analyses
-- ============================================================================
create table public.response_analyses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  platform          text not null,
  conversation_id   text not null,
  message_id        text not null,
  prompt_length     int  not null default 0,
  response_length   int  not null default 0,
  skipped           bool not null default false,
  skip_reason       text,
  provocation_count int  not null default 0,
  tokens_in         int  not null default 0,
  tokens_out        int  not null default 0,
  cached_tokens     int  not null default 0,
  latency_ms        int  not null default 0,
  prompt_version    text not null,
  provocations      jsonb,
  created_at        timestamptz not null default now()
);

create index response_analyses_user_id_created_at_idx
  on public.response_analyses (user_id, created_at desc);

create index response_analyses_skip_reason_idx
  on public.response_analyses (skip_reason)
  where skip_reason is not null;

create index response_analyses_prompt_version_idx
  on public.response_analyses (prompt_version);

alter table public.response_analyses enable row level security;

create policy "users select own analyses"
  on public.response_analyses for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for end users.
-- All writes happen via the service-role key from /api/analyze-response.

-- ============================================================================
-- provocation_events
-- ============================================================================
create table public.provocation_events (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references public.response_analyses(id) on delete cascade,
  provocation_index int  not null,
  lens              text not null,
  severity          text not null,
  event_type        text not null
    check (event_type in ('shown', 'expanded', 'sent_to_ai', 'dismissed', 'copied')),
  created_at        timestamptz not null default now()
);

create index provocation_events_analysis_id_idx
  on public.provocation_events (analysis_id);

create index provocation_events_event_type_created_at_idx
  on public.provocation_events (event_type, created_at desc);

alter table public.provocation_events enable row level security;

-- Users can read their own events via the join to response_analyses.
create policy "users select own events"
  on public.provocation_events for select
  using (
    exists (
      select 1 from public.response_analyses ra
      where ra.id = analysis_id and ra.user_id = auth.uid()
    )
  );

-- ============================================================================
-- user_usage — monthly per-user counters for free-tier quota enforcement
-- ============================================================================
create table public.user_usage (
  user_id                   uuid not null references auth.users(id) on delete cascade,
  month_key                 text not null,
  pre_prompt_interceptions  int  not null default 0,
  response_analyses         int  not null default 0,
  updated_at                timestamptz not null default now(),
  primary key (user_id, month_key)
);

alter table public.user_usage enable row level security;

create policy "users select own usage"
  on public.user_usage for select
  using (auth.uid() = user_id);

-- ============================================================================
-- View: provocation_engagement_with_email
-- Joins events → analyses → auth.users.email for analytics dashboards.
-- Inherits RLS from underlying tables.
-- ============================================================================
create view public.provocation_engagement_with_email
  with (security_invoker = true)
  as
select
  pe.id              as event_id,
  pe.analysis_id,
  pe.provocation_index,
  pe.lens,
  pe.severity,
  pe.event_type,
  pe.created_at      as event_created_at,
  ra.user_id,
  ra.platform,
  ra.prompt_version,
  ra.skipped,
  ra.skip_reason,
  u.email
from public.provocation_events pe
join public.response_analyses ra on ra.id = pe.analysis_id
join auth.users u                on u.id = ra.user_id;
