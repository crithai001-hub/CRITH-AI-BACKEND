-- Crith AI V2 — expand provocation_events.event_type CHECK to include
-- 'explained', 'useful', and 'not_useful' (added in extension v2 with
-- the Explain button + rating buttons).
--
-- Idempotent: drops the existing CHECK constraint by name (if present)
-- and adds the new one. Safe to re-run.

do $$
declare
  cn text;
begin
  -- Find any existing CHECK constraint on provocation_events.event_type.
  -- The constraint in 0001 was unnamed, so Postgres assigned an auto-generated
  -- name — locate it by definition rather than hardcoding.
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
    'not_useful'
  ));
