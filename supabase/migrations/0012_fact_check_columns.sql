-- Crith AI V2 — fact-checker MVP schema changes
--
-- 1. Adds as_of_date and was_true_until to claim_verifications. These are the
--    recency-awareness payload — every verification carries the date it was
--    judged as-of, and a was_true_until date when the claim was once true and
--    has gone stale. The verifier prompt is responsible for populating them.
-- 2. Expands the analysis_kind CHECK constraint to allow the new endpoint
--    values fact_check and fact_check_selection. The old values stay legal so
--    historical rows keep type-checking — they'll be deleted in a later
--    cleanup migration once the old endpoints are gone for a week.
--
-- Idempotent: same drop-by-name pattern as 0011 for the CHECK constraint.

alter table public.claim_verifications
  add column if not exists as_of_date date,
  add column if not exists was_true_until date;

do $$
declare
  cn text;
begin
  select conname into cn
  from pg_constraint
  where conrelid = 'public.response_analyses'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%analysis_kind%';

  if cn is not null then
    execute format('alter table public.response_analyses drop constraint %I', cn);
  end if;
end $$;

alter table public.response_analyses
  add constraint response_analyses_kind_check
  check (analysis_kind in (
    'response_analysis',
    'ask_crith',
    'fact_check',
    'fact_check_selection'
  ));
