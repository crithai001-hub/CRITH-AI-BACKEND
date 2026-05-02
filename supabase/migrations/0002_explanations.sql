-- Crith AI V2 — explanations migration
-- Adds:
--   - response_analyses.original_prompt and .original_response (full context for the explainer)
--   - provocation_explanations table (logs each successful /api/explain-provocation call)
-- RLS pattern matches 0001: users SELECT own rows; INSERTs via service role only.

-- ============================================================================
-- response_analyses additions
-- ============================================================================
-- Nullable on purpose. Pre-migration rows stay NULL; the explainer endpoint
-- returns 404 for those instead of trying to call Claude with empty context.
alter table public.response_analyses
  add column if not exists original_prompt   text,
  add column if not exists original_response text;

-- ============================================================================
-- provocation_explanations
-- ============================================================================
create table public.provocation_explanations (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid not null references public.response_analyses(id) on delete cascade,
  provocation_index int  not null,
  user_id           uuid not null references auth.users(id) on delete cascade,
  tokens_in         int  not null default 0,
  tokens_out        int  not null default 0,
  latency_ms        int  not null default 0,
  prompt_version    text not null,
  created_at        timestamptz not null default now()
);

create index provocation_explanations_user_id_created_at_idx
  on public.provocation_explanations (user_id, created_at desc);

create index provocation_explanations_analysis_id_idx
  on public.provocation_explanations (analysis_id);

alter table public.provocation_explanations enable row level security;

create policy "users select own explanations"
  on public.provocation_explanations for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies for end users.
-- All writes happen via the service-role key from /api/explain-provocation.
