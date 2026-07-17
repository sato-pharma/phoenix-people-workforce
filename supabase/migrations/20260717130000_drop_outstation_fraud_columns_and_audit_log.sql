-- Remove the outstation fraud footprint from the database ("no traces").
--
-- The fraud / high-risk system was removed from the application (no code reads or writes
-- these any more). This migration drops the dead fraud columns and the GPS fraud
-- audit-log table. That table is referenced by one arm of the v_unified_audit_logs view,
-- so the view is recreated WITHOUT that arm first (the column set is unchanged, only the
-- UNION arm is removed).
--
-- Companion to 20260717120000_drop_outstation_variance_columns.sql. Apply staging-first.

-- 1. Recreate the unified audit view without the outstation_location_audit_logs arm.
CREATE OR REPLACE VIEW public.v_unified_audit_logs WITH (security_invoker='true') AS
 SELECT 'audit_logs'::text AS source,
    (audit_logs.id)::text AS id,
    audit_logs.actor_login_id AS actor_id,
    'system'::text AS actor_type,
    audit_logs.entity_type,
    audit_logs.entity_id,
    audit_logs.summary AS action,
    audit_logs.summary,
    audit_logs.new_values AS metadata,
    audit_logs.created_at,
        CASE
            WHEN (audit_logs.summary ~~* '%reject%'::text) THEN 'rejected'::text
            WHEN ((audit_logs.summary ~~* '%fail%'::text) OR (audit_logs.summary ~~* '%error%'::text)) THEN 'failed'::text
            WHEN (audit_logs.summary ~~* '%approve%'::text) THEN 'approved'::text
            WHEN ((audit_logs.summary ~~* '%success%'::text) OR (audit_logs.summary ~~* '%succeed%'::text) OR (audit_logs.summary ~~* '%sent%'::text) OR (audit_logs.summary ~~* '%accepted%'::text)) THEN 'succeeded'::text
            ELSE 'changed'::text
        END AS status,
        CASE
            WHEN (audit_logs.entity_type = 'auth_session'::text) THEN 'auth'::text
            WHEN (audit_logs.entity_type = ANY (ARRAY['permission_override'::text, 'salary_flag'::text, 'user'::text])) THEN 'access'::text
            WHEN (audit_logs.entity_type = 'coaching_report'::text) THEN 'coaching'::text
            ELSE 'governance'::text
        END AS module
   FROM public.audit_logs
UNION ALL
 SELECT 'sales_audit_logs'::text AS source,
    (sales_audit_logs.id)::text AS id,
    COALESCE(sales_audit_logs.actor_username, 'system'::text) AS actor_id,
    'user'::text AS actor_type,
    'sales_import'::text AS entity_type,
    (sales_audit_logs.batch_id)::text AS entity_id,
    sales_audit_logs.action,
    sales_audit_logs.action AS summary,
    (sales_audit_logs.metadata || jsonb_build_object('line', sales_audit_logs.line, 'period', sales_audit_logs.period)) AS metadata,
    sales_audit_logs.created_at,
        CASE
            WHEN (sales_audit_logs.action ~~* '%reject%'::text) THEN 'rejected'::text
            WHEN ((sales_audit_logs.action ~~* '%fail%'::text) OR (sales_audit_logs.action ~~* '%error%'::text)) THEN 'failed'::text
            WHEN (sales_audit_logs.action ~~* '%approve%'::text) THEN 'approved'::text
            ELSE 'succeeded'::text
        END AS status,
    'sales'::text AS module
   FROM public.sales_audit_logs
UNION ALL
 SELECT 'job_offer_audit_logs'::text AS source,
    (job_offer_audit_logs.id)::text AS id,
    job_offer_audit_logs.actor_reference AS actor_id,
    job_offer_audit_logs.actor_type,
    'job_offer'::text AS entity_type,
    (job_offer_audit_logs.offer_id)::text AS entity_id,
    job_offer_audit_logs.action,
    job_offer_audit_logs.action AS summary,
    job_offer_audit_logs.details AS metadata,
    job_offer_audit_logs.created_at,
        CASE
            WHEN (job_offer_audit_logs.action ~~* '%reject%'::text) THEN 'rejected'::text
            WHEN ((job_offer_audit_logs.action ~~* '%fail%'::text) OR (job_offer_audit_logs.action ~~* '%error%'::text)) THEN 'failed'::text
            WHEN (job_offer_audit_logs.action ~~* '%approve%'::text) THEN 'approved'::text
            ELSE 'succeeded'::text
        END AS status,
    'recruitment'::text AS module
   FROM public.job_offer_audit_logs
UNION ALL
 SELECT 'coaching_report_audit_logs'::text AS source,
    (coaching_report_audit_logs.id)::text AS id,
    coaching_report_audit_logs.actor_hr_id AS actor_id,
    'employee'::text AS actor_type,
    'coaching_report'::text AS entity_type,
    (coaching_report_audit_logs.report_id)::text AS entity_id,
    coaching_report_audit_logs.action,
    coaching_report_audit_logs.action AS summary,
    (coaching_report_audit_logs.metadata || jsonb_build_object('old_values', coaching_report_audit_logs.old_values, 'new_values', coaching_report_audit_logs.new_values)) AS metadata,
    coaching_report_audit_logs.created_at,
        CASE
            WHEN (coaching_report_audit_logs.action ~~* '%reject%'::text) THEN 'rejected'::text
            WHEN ((coaching_report_audit_logs.action ~~* '%fail%'::text) OR (coaching_report_audit_logs.action ~~* '%error%'::text)) THEN 'failed'::text
            WHEN (coaching_report_audit_logs.action ~~* '%approve%'::text) THEN 'approved'::text
            ELSE 'succeeded'::text
        END AS status,
    'coaching'::text AS module
   FROM public.coaching_report_audit_logs;

-- 2. Drop the now-orphaned GPS fraud audit-log table.
DROP TABLE IF EXISTS public.outstation_location_audit_logs;

-- 3. Drop the dead fraud columns from the outstation requests table.
ALTER TABLE public.outstation_expense_requests
  DROP COLUMN IF EXISTS fraud_flags_json,
  DROP COLUMN IF EXISTS suspicious_location_score;
