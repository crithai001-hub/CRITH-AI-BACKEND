-- Crith AI V2 — verifier prompt v2 schema fixes
--
-- 1. Replace the verdict CHECK constraint. The 0013 migration set the verdicts
--    to {found_supporting, found_contradicting, could_not_verify, error};
--    verifier prompt v2 emits the shorter evidence-state names
--    {supported, contradicted, unverified, error}. Without this fix every
--    successful non-error verification fails the CHECK and the insert returns
--    an error to the user.
--
-- 2. Add claim_subtype column to claim_verifications. The verifier user prompt
--    receives the subtype (citation/statistic/quote/entity/general) and we
--    persist it alongside the verdict for analytics (which subtypes most often
--    end up "contradicted" or "unverified").
--
-- Idempotent: claim_subtype uses `if not exists`; the verdict CHECK is dropped
-- by name lookup (same pattern as 0011/0012/0013) before being re-added.

alter table public.claim_verifications
  add column if not exists claim_subtype text;

do $$
declare
  cn text;
begin
  select conname into cn
  from pg_constraint
  where conrelid = 'public.claim_verifications'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%verdict%';

  if cn is not null then
    execute format('alter table public.claim_verifications drop constraint %I', cn);
  end if;
end $$;

alter table public.claim_verifications
  add constraint claim_verifications_verdict_check
  check (verdict in (
    'supported',
    'contradicted',
    'unverified',
    'error'
  ));
