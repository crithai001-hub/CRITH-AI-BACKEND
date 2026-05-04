-- Crith AI V2 — claim verification schema (parallel claim extractor + verify endpoint)
-- Adds columns to response_analyses for the parallel claim extractor's output and
-- introduces claim_verifications for on-demand /api/verify-claim results.

-- ============================================================================
-- response_analyses additions
-- ============================================================================
alter table public.response_analyses
  add column if not exists verifiable_claims jsonb not null default '[]'::jsonb,
  add column if not exists claim_extractor_version text,
  add column if not exists claim_extractor_tokens_in int,
  add column if not exists claim_extractor_tokens_out int;

comment on column public.response_analyses.verifiable_claims is
  'Output from claim-extractor-prompt. Parallel to validations. v1+';

-- ============================================================================
-- claim_verifications — one row per /api/verify-claim invocation
-- ============================================================================
create table if not exists public.claim_verifications (
  id                  uuid primary key default gen_random_uuid(),
  analysis_id         uuid not null references public.response_analyses(id) on delete cascade,
  claim_index         int  not null,
  user_id             uuid not null references auth.users(id) on delete cascade,
  verdict             text not null check (verdict in ('confirmed', 'contradicted', 'inconclusive', 'error')),
  evidence_summary    text,
  source_urls         jsonb not null default '[]'::jsonb,
  search_tokens_used  int,
  haiku_tokens_in     int,
  haiku_tokens_out    int,
  latency_ms          int,
  created_at          timestamptz not null default now()
);

create index if not exists claim_verifications_user_id_created_at_idx
  on public.claim_verifications (user_id, created_at desc);

create index if not exists claim_verifications_analysis_id_idx
  on public.claim_verifications (analysis_id);

create index if not exists claim_verifications_verdict_idx
  on public.claim_verifications (verdict);

alter table public.claim_verifications enable row level security;

create policy "users see own verifications"
  on public.claim_verifications for select
  using (user_id = auth.uid());

-- No INSERT policy for end users — writes happen via service role from /api/verify-claim.
