-- Remove RLS as the single point of failure on 54 tables that anon/authenticated can
-- currently be GRANTed to read (and mostly to DELETE and TRUNCATE).
--
-- WHY
-- Every table in `public` was created while Postgres' default ACL handed anon and
-- authenticated full privileges (see 20260809130000_public_default_privileges_revoke_anon.sql,
-- which stopped that for NEW tables). The tables created before that still carry the grant.
--
-- They are not exposed today: RLS is enabled and these particular 54 have NO policies at all,
-- so anon and authenticated are denied every row regardless of the grant. The grant is inert.
--
-- The problem is that RLS is then the ONLY thing standing between the anon key — which ships
-- in the browser bundle of the public login page — and this data. On 2026-08-09 six ad-hoc
-- `zz_backup_*` tables were found in exactly the state this guards against: created without
-- RLS, inheriting the same grant, and therefore fully readable AND truncatable by anyone.
-- Removing the grant means an RLS slip alone is no longer enough to expose anything.
--
-- 51 of these 54 currently grant anon DELETE and TRUNCATE. The list includes
-- marketing_customers, probation_feedback, report_it_reports, direct_order_requests and
-- weekly_sales_rows.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
--   * 84 tables that DO have RLS policies. Their grant may be load-bearing: a GRANT and a
--     policy are AND-ed, so removing the grant would break any path the policy permits.
--   * outstation_expense_requests, outstation_expenses, salary_batches — queried through
--     getSupabaseRlsClient() (src/lib/supabase/rls-server.ts), which connects as
--     `authenticated`. Those three sit in the policy group above and are excluded anyway.
--   * source_of_sales_customer_map — inert like the 54, but it backs
--     source_of_sales_block_groups, a security_invoker view granted to anon/authenticated.
--     A security_invoker view reads as the CALLER, so revoking the base-table grant could
--     break it. Left alone rather than reasoned about.
--
-- BLAST RADIUS: none today. All 54 already deny anon and authenticated every row. The
-- application connects as service_role, which bypasses both RLS and these grants. Verified
-- 2026-08-09: the only Supabase clients in the codebase are the service-role admin client and
-- an RLS client used for the three tables named above; nothing in the browser queries
-- PostgREST.
--
-- SELF-GUARDING: each revoke re-checks, at run time, that the table still exists and STILL has
-- zero policies. If a policy has been added since this was written, the grant may have become
-- load-bearing and that table is skipped rather than broken. This also makes the migration
-- safe to re-run and safe on an environment where these tables differ.
--
-- Rollback: grant the privileges back, e.g.
--   grant select, insert, update, delete on public.<table> to anon, authenticated;

do $$
declare
  target text;
  skipped_policy text[] := '{}';
  skipped_missing text[] := '{}';
  revoked int := 0;
  targets text[] := array[
    'app_error_events',
    'ats_whatsapp_inbound_messages',
    'background_jobs',
    'blocked_ips',
    'direct_order_approval_steps',
    'direct_order_caps',
    'direct_order_events',
    'direct_order_pharmacies',
    'direct_order_pharmacy_distributor_codes',
    'direct_order_requests',
    'doctor_coverage_config',
    'employee_plan_visit_details',
    'marketing_customer_contacts',
    'marketing_customer_pharmacies',
    'marketing_customers',
    'marketing_evidence_files',
    'marketing_pharmacies',
    'marketing_pharmacy_code_references',
    'marketing_pharmacy_distributor_codes',
    'marketing_request_approval_steps',
    'marketing_request_finance_requirements',
    'marketing_request_pharmacies',
    'marketing_request_products',
    'marketing_requests',
    'monthly_closing_publications',
    'notification_send_reviews',
    'pm_product_assignments',
    'private_calendar_data_disputes',
    'private_calendar_no_activity_clarifications',
    'probation_assessments',
    'probation_cases',
    'probation_config',
    'probation_development_actions',
    'probation_dv_days',
    'probation_dv_ingest_issues',
    'probation_dv_visits',
    'probation_feedback',
    'probation_feedback_comments',
    'probation_feedback_submissions',
    'probation_feedback_versions',
    'probation_provisioning_failures',
    'report_it_audit_logs',
    'report_it_reports',
    'sales_area_region_codes',
    'sales_distributor_codes',
    'sales_product_codes',
    'source_of_sales_distributor_certification',
    'source_of_sales_mapping_audit',
    'weekly_sales_batches',
    'weekly_sales_branch_region_map',
    'weekly_sales_pos_region_mappings',
    'weekly_sales_product_aliases',
    'weekly_sales_product_scope',
    'weekly_sales_rows'
  ];
begin
  foreach target in array targets loop
    if to_regclass(format('public.%I', target)) is null then
      skipped_missing := skipped_missing || target;
      continue;
    end if;

    -- The safety condition, re-evaluated now rather than trusted from when this was authored.
    if exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = target
    ) then
      skipped_policy := skipped_policy || target;
      continue;
    end if;

    execute format('revoke all on public.%I from anon', target);
    execute format('revoke all on public.%I from authenticated', target);
    revoked := revoked + 1;
  end loop;

  raise notice 'revoke_inert_anon_grants: revoked %, skipped % (policy added since authoring), skipped % (table absent)',
    revoked, coalesce(array_length(skipped_policy, 1), 0), coalesce(array_length(skipped_missing, 1), 0);

  if array_length(skipped_policy, 1) > 0 then
    raise notice 'revoke_inert_anon_grants: left alone because they now have policies: %', skipped_policy;
  end if;
end
$$;
