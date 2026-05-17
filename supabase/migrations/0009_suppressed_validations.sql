-- Crith AI V2 — suppressed_validations column
-- Splits the validator's output into two tiers stored on the same row:
--   - validations: severe + directly tied to user's ask. Rendered inline.
--   - suppressed_validations: broader findings that passed quality gates but
--     not the severity bar. Rendered in the expandable report panel.
--
-- Same shape as validations. Hallucination/claim-extractor output continues
-- to live in verifiable_claims and is unaffected by this migration.

alter table public.response_analyses
  add column if not exists suppressed_validations jsonb not null default '[]'::jsonb;

comment on column public.response_analyses.suppressed_validations is
  'v24+ schema. Broader findings the validator routed away from inline display so the main UI shows only severe + directly-relevant flags. Same {problem, follow_up_prompt, lens, anchored_to, severity} shape as validations.';
