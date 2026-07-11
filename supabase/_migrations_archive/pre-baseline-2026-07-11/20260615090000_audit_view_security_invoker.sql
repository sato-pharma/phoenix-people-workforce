-- ============================================================================
-- Capture v_unified_audit_logs into source control + convert to SECURITY INVOKER
-- ----------------------------------------------------------------------------
-- Finding (Critical): public.v_unified_audit_logs existed only in the live
-- database (no source-controlled definition) AND was a SECURITY DEFINER view
-- (Supabase security advisor ERROR 0010). A definer view over audit data
-- enforces the *creator's* permissions/RLS rather than the querying user's,
-- so it can leak audit rows past RLS and is unreviewable/unreproducible.
--
-- Fix:
--   1) Source-control the exact live definition (faithful, schema-qualified).
--   2) Set security_invoker = true so the view honours the querying role's RLS.
--
-- Safety / blast radius: the application reads audit data via the service-role
-- (RLS-bypassing) admin client, which is unaffected by security_invoker. A
-- direct authenticated PostgREST read is now correctly subject to the RLS on the
-- underlying audit tables (which expose nothing to `authenticated`), i.e. the
-- secure behaviour. No application code references this view (grep: only docs).
-- Follows the existing repo pattern (see 20260511_rls_gap_closure.sql, which
-- converts v_hr_id_orphan_audit / v_employee_locations_masked the same way).
-- Reversible: re-create the view WITHOUT the WITH (...) option.
-- ============================================================================

create or replace view public.v_unified_audit_logs
  with (security_invoker = true)
as
 SELECT 'audit_logs'::text AS source,
    audit_logs.id::text AS id,
    audit_logs.actor_login_id AS actor_id,
    'system'::text AS actor_type,
    audit_logs.entity_type,
    audit_logs.entity_id,
    audit_logs.summary AS action,
    audit_logs.summary,
    audit_logs.new_values AS metadata,
    audit_logs.created_at,
        CASE
            WHEN audit_logs.summary ~~* '%reject%'::text THEN 'rejected'::text
            WHEN audit_logs.summary ~~* '%fail%'::text OR audit_logs.summary ~~* '%error%'::text THEN 'failed'::text
            WHEN audit_logs.summary ~~* '%approve%'::text THEN 'approved'::text
            WHEN audit_logs.summary ~~* '%success%'::text OR audit_logs.summary ~~* '%succeed%'::text OR audit_logs.summary ~~* '%sent%'::text OR audit_logs.summary ~~* '%accepted%'::text THEN 'succeeded'::text
            ELSE 'changed'::text
        END AS status,
        CASE
            WHEN audit_logs.entity_type = 'auth_session'::text THEN 'auth'::text
            WHEN audit_logs.entity_type = ANY (ARRAY['permission_override'::text, 'salary_flag'::text, 'user'::text]) THEN 'access'::text
            WHEN audit_logs.entity_type = 'coaching_report'::text THEN 'coaching'::text
            ELSE 'governance'::text
        END AS module
   FROM public.audit_logs
UNION ALL
 SELECT 'sales_audit_logs'::text AS source,
    sales_audit_logs.id::text AS id,
    COALESCE(sales_audit_logs.actor_username, 'system'::text) AS actor_id,
    'user'::text AS actor_type,
    'sales_import'::text AS entity_type,
    sales_audit_logs.batch_id::text AS entity_id,
    sales_audit_logs.action,
    sales_audit_logs.action AS summary,
    sales_audit_logs.metadata || jsonb_build_object('line', sales_audit_logs.line, 'period', sales_audit_logs.period) AS metadata,
    sales_audit_logs.created_at,
        CASE
            WHEN sales_audit_logs.action ~~* '%reject%'::text THEN 'rejected'::text
            WHEN sales_audit_logs.action ~~* '%fail%'::text OR sales_audit_logs.action ~~* '%error%'::text THEN 'failed'::text
            WHEN sales_audit_logs.action ~~* '%approve%'::text THEN 'approved'::text
            ELSE 'succeeded'::text
        END AS status,
    'sales'::text AS module
   FROM public.sales_audit_logs
UNION ALL
 SELECT 'job_offer_audit_logs'::text AS source,
    job_offer_audit_logs.id::text AS id,
    job_offer_audit_logs.actor_reference AS actor_id,
    job_offer_audit_logs.actor_type,
    'job_offer'::text AS entity_type,
    job_offer_audit_logs.offer_id::text AS entity_id,
    job_offer_audit_logs.action,
    job_offer_audit_logs.action AS summary,
    job_offer_audit_logs.details AS metadata,
    job_offer_audit_logs.created_at,
        CASE
            WHEN job_offer_audit_logs.action ~~* '%reject%'::text THEN 'rejected'::text
            WHEN job_offer_audit_logs.action ~~* '%fail%'::text OR job_offer_audit_logs.action ~~* '%error%'::text THEN 'failed'::text
            WHEN job_offer_audit_logs.action ~~* '%approve%'::text THEN 'approved'::text
            ELSE 'succeeded'::text
        END AS status,
    'recruitment'::text AS module
   FROM public.job_offer_audit_logs
UNION ALL
 SELECT 'coaching_report_audit_logs'::text AS source,
    coaching_report_audit_logs.id::text AS id,
    coaching_report_audit_logs.actor_hr_id AS actor_id,
    'employee'::text AS actor_type,
    'coaching_report'::text AS entity_type,
    coaching_report_audit_logs.report_id::text AS entity_id,
    coaching_report_audit_logs.action,
    coaching_report_audit_logs.action AS summary,
    coaching_report_audit_logs.metadata || jsonb_build_object('old_values', coaching_report_audit_logs.old_values, 'new_values', coaching_report_audit_logs.new_values) AS metadata,
    coaching_report_audit_logs.created_at,
        CASE
            WHEN coaching_report_audit_logs.action ~~* '%reject%'::text THEN 'rejected'::text
            WHEN coaching_report_audit_logs.action ~~* '%fail%'::text OR coaching_report_audit_logs.action ~~* '%error%'::text THEN 'failed'::text
            WHEN coaching_report_audit_logs.action ~~* '%approve%'::text THEN 'approved'::text
            ELSE 'succeeded'::text
        END AS status,
    'coaching'::text AS module
   FROM public.coaching_report_audit_logs
UNION ALL
 SELECT 'outstation_location_audit_logs'::text AS source,
    outstation_location_audit_logs.id::text AS id,
    outstation_location_audit_logs.employee_hr_id AS actor_id,
    'employee'::text AS actor_type,
    'outstation_location'::text AS entity_type,
    outstation_location_audit_logs.expense_request_id::text AS entity_id,
    outstation_location_audit_logs.validation_result AS action,
    outstation_location_audit_logs.validation_reason AS summary,
    outstation_location_audit_logs.fraud_flags_json AS metadata,
    outstation_location_audit_logs.created_at,
    outstation_location_audit_logs.validation_result AS status,
    'outstation'::text AS module
   FROM public.outstation_location_audit_logs;

-- Defensive: ensure the option is set even if a future CREATE OR REPLACE omits it.
alter view public.v_unified_audit_logs set (security_invoker = true);
