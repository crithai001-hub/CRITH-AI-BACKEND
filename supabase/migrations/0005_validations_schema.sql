-- Crith AI V2 — v14 validations schema migration
-- Adds the new `validations` jsonb column to response_analyses and extends
-- the provocation_events.event_type CHECK constraint to allow 'asked_ai'
-- (fired when the user taps "Ask AI" on the new validation card UX).
--
-- Old `provocations` column stays — pre-v14 rows still hold meaningful data
-- there. Going forward analyze-response writes only to `validations`.

-- ============================================================================
-- response_analyses additions
-- ============================================================================
alter table public.response_analyses
  add column if not exists validations jsonb not null default '[]'::jsonb;

comment on column public.response_analyses.validations is
  'v14+ schema. Contains problem, follow_up_prompt, lens, anchored_to, severity. Replaces provocations column going forward.';

-- ============================================================================
-- provocation_events.event_type — add 'asked_ai'
-- ============================================================================
-- Idempotent: drops the existing CHECK constraint by name (if present)
-- and adds the new one. Same lookup-by-definition pattern as 0003.
do $$
declare
  cn text;
begin
  select conname into cn
  from pg_constraint
  where conrelid = 'public.provocation_events'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%event_type%';

  if cn is not null then
    execute format('alter table public.provocation_events drop constraint %I', cn);
  end if;
end $$;

alter table public.provocation_events
  add constraint provocation_events_event_type_check
  check (event_type in (
    'shown',
    'expanded',
    'sent_to_ai',
    'dismissed',
    'copied',
    'explained',
    'useful',
    'not_useful',
    'asked_ai'
  ));
