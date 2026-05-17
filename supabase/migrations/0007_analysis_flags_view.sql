-- Crith AI V2 — flat analysis view for prompt/response/flag inspection
-- Pivots response_analyses.validations into one row per flag, with the
-- original prompt + response + skip metadata on every row. Built for
-- offline prompt-tuning: spray test prompts at /api/analyze-response,
-- then sort/filter the resulting flags in Supabase Studio in one place.
--
-- This is a VIEW, not a table — the underlying data already lives on
-- response_analyses. Inherits RLS from the base table via security_invoker.
-- LEFT JOIN means analyses that produced zero flags (skipped, or empty
-- validations) still appear as one row with null flag fields, so you can
-- see what was skipped and why without joining a second time.

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
  ra.latency_ms
from public.response_analyses ra
left join lateral jsonb_array_elements(ra.validations)
  with ordinality as v(elem, ord) on true;

comment on view public.analysis_flags_flat is
  'One row per flagged validation, joined with the originating prompt + response. Analyses with zero flags appear once with null flag fields. Inherits RLS from response_analyses.';
