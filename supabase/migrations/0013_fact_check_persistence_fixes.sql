-- Crith AI V2 — fact-checker MVP persistence fixes
--
-- Three changes required by the new verifier wire shape:
--
-- 1. Add follow_up_prompt column. The verifier emits a first-person prompt
--    the user can fire back at the AI. Stored so analytics can replay the
--    suggested follow-up alongside the verdict.
--
-- 2. Replace the verdict CHECK constraint. The old constraint allowed
--    {confirmed, contradicted, inconclusive, error}; the new verifier emits
--    {found_supporting, found_contradicting, could_not_verify, error}. Without
--    this fix every successful non-error verification fails the CHECK and the
--    insert returns an error to the user.
--
-- 3. Add gemini_tokens_in / gemini_tokens_out. The Gemini-grounded verifier
--    replaces the legacy Haiku call; we keep haiku_tokens_* columns nullable
--    for historical rows and write new rows into the gemini_* columns.
--
-- Idempotent: column adds use `if not exists`; the CHECK constraint is dropped
-- by name lookup (same pattern as 0011 and 0012) before being re-added.

alter table public.claim_verifications
  add column if not exists follow_up_prompt text,
  add column if not exists gemini_tokens_in int,
  add column if not exists gemini_tokens_out int,
  add column if not exists as_of_date date,
  add column if not exists was_true_until date;
-- (as_of_date / was_true_until are already added in 0012; the duplicate
--  `add column if not exists` here is safe and makes 0013 standalone-readable.)

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
    'found_supporting',
    'found_contradicting',
    'could_not_verify',
    'error'
  ));
