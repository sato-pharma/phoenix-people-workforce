-- Probation structured scorecard config (Phase 4, P4-T03).
--
-- The feedback form is a structured scorecard, not a free-text box. The dimensions are
-- admin-configurable (centrally, like the rest of probation_config); the scale stays the
-- owner-locked 1..10 already in probation_config.scoring_scale. Additive + idempotent.

begin;

alter table public.probation_config
  add column if not exists scorecard_dimensions jsonb not null default
    '["medical_knowledge","product_knowledge","communication","selling_skills","customer_engagement","call_planning","objection_handling","closing_skills","professional_behavior","crm_compliance","coachability","overall_field_readiness"]'::jsonb;

notify pgrst, 'reload schema';

commit;
