-- Crith AI V2 — extend analysis_flags_flat with tier column
-- Adds suppressed flags into the view as a second SELECT branch with
-- tier = 'suppressed'. Inline flags remain as tier = 'inline'.
-- Filter by tier in Supabase Studio to inspect what would be shown on the
-- main UI vs. the report panel for any given analysis.
--
-- Note: tier appended at the END of the column list rather than slotted
-- next to flag_index because CREATE OR REPLACE VIEW only allows appending,
-- not reordering. Cosmetic only.

create or replace view public.analysis_flags_flat
  with (security_invoker = true)
  as
select
  ra.id                                   as analysis_id,
  ra.created_at,
  ra.user_id,
  ra.platform,
  ra.prompt_version,
  ra.skipped,
  ra.skip_reason,
  ra.prompt_length,
  ra.response_length,
  ra.provocation_count                    as flag_count_total,
  ra.original_prompt                      as prompt,
  ra.original_response                    as response,
  v.ord::int                              as flag_index,
  (v.elem ->> 'lens')                     as lens,
  (v.elem ->> 'severity')                 as severity,
  (v.elem ->> 'problem')                  as problem,
  (v.elem ->> 'follow_up_prompt')         as follow_up_prompt,
  (v.elem ->> 'anchored_to')              as anchored_to,
  ra.conversation_history_turn_count,
  ra.tokens_in,
  ra.tokens_out,
  ra.cached_tokens,
  ra.latency_ms,
  'inline'::text                          as tier
from public.response_analyses ra
left join lateral jsonb_array_elements(ra.validations)
  with ordinality as v(elem, ord) on true

union all

select
  ra.id                                   as analysis_id,
  ra.created_at,
  ra.user_id,
  ra.platform,
  ra.prompt_version,
  ra.skipped,
  ra.skip_reason,
  ra.prompt_length,
  ra.response_length,
  ra.provocation_count                    as flag_count_total,
  ra.original_prompt                      as prompt,
  ra.original_response                    as response,
  s.ord::int                              as flag_index,
  (s.elem ->> 'lens')                     as lens,
  (s.elem ->> 'severity')                 as severity,
  (s.elem ->> 'problem')                  as problem,
  (s.elem ->> 'follow_up_prompt')         as follow_up_prompt,
  (s.elem ->> 'anchored_to')              as anchored_to,
  ra.conversation_history_turn_count,
  ra.tokens_in,
  ra.tokens_out,
  ra.cached_tokens,
  ra.latency_ms,
  'suppressed'::text                      as tier
from public.response_analyses ra
inner join lateral jsonb_array_elements(ra.suppressed_validations)
  with ordinality as s(elem, ord) on true;

comment on view public.analysis_flags_flat is
  'One row per flag. tier=inline for validations (severe + directly relevant, max 2); tier=suppressed for the broader report-panel flags (max 4). Analyses with zero inline flags still appear once via the first SELECT with null flag fields.';
