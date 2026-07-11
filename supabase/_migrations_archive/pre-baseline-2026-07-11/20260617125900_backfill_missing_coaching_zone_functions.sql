-- Backfill: public.phx_coaching_item_definition and public.phx_coaching_zone.
--
-- 20260602194402_coaching_reports_schema.sql is recorded as applied in production's
-- migration history, but these two functions (defined in that same file) were never
-- actually created there — confirmed by direct inspection of pg_proc on production.
-- Every other object from that migration (tables, views, the other three functions)
-- exists correctly; only these two are missing. 20260617130000_coaching_scale_5.sql
-- calls phx_coaching_zone and fails on production without this backfill.
--
-- Both definitions are copied verbatim from 20260602194402_coaching_reports_schema.sql.
-- CREATE OR REPLACE FUNCTION — idempotent, no data touched.

create or replace function public.phx_coaching_item_definition(p_key text)
returns table (
  display_order integer,
  parameter_category text,
  score_item_label text
)
language sql
stable
as $$
  select item.display_order, item.parameter_category, item.score_item_label
  from (
    values
      (1, 'knowledge', 'medical_patient_knowledge', 'Medical & Patient/Physician Knowledge'),
      (2, 'knowledge', 'product_knowledge', 'Product Knowledge'),
      (3, 'knowledge', 'competitor_knowledge', 'Competitor Knowledge'),
      (4, 'call_structure_skills', 'opening_patient_profile_attractive_approach', 'Opening, Patient Profile & Attractive Approach'),
      (5, 'call_structure_skills', 'asking_questions_probing', 'Asking Questions / Probing'),
      (6, 'call_structure_skills', 'presentation_skills', 'Presentation Skills'),
      (7, 'call_structure_skills', 'closing_asking_for_business', 'Closing & Asking for Business'),
      (8, 'business_intelligence', 'handling_customer_objection', 'Handling Customer Objection'),
      (9, 'business_intelligence', 'body_language_tone_of_voice', 'Body Language & Tone of Voice'),
      (10, 'business_intelligence', 'professional_pharmacy_feedback', 'Professional Pharmacy Feedback'),
      (11, 'business_intelligence', 'assertiveness_asking_for_business', 'Assertiveness in Asking for Business'),
      (12, 'business_intelligence', 'customer_adaptation_relationship', 'Customer Adaptation & Relationship'),
      (13, 'business_planning', 'time_territory_planning', 'Time & Territory Planning'),
      (14, 'business_planning', 'using_promotional_material', 'Using Promotional Material'),
      (15, 'business_planning', 'pre_call_planning', 'Pre-Call Planning'),
      (16, 'business_planning', 'execution_follow_up', 'Execution & Follow-Up'),
      (17, 'personal_skills', 'appearance', 'Appearance'),
      (18, 'personal_skills', 'dress_code', 'Dress Code'),
      (19, 'personal_skills', 'attitude', 'Attitude'),
      (20, 'personal_skills', 'discipline', 'Discipline')
  ) as item(display_order, parameter_category, score_item_key, score_item_label)
  where item.score_item_key = p_key;
$$;

create or replace function public.phx_coaching_zone(p_percent numeric)
returns text
language sql
immutable
as $$
  select case
    when p_percent < 50 then 'critical_red'
    when p_percent <= 65 then 'red_zone'
    when p_percent <= 80 then 'yellow_zone'
    when p_percent <= 90 then 'green_zone'
    else 'excellence_zone'
  end;
$$;
