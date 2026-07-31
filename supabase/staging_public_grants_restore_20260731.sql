-- =============================================================================
-- STAGING REPAIR — restore the public-schema grant matrix that was wiped
-- =============================================================================
-- Target:  STAGING ONLY  (cifwmndunmlxjhyjugxa / Phoenix-HR-Staging)
-- Author:  generated 2026-07-31 by reading PRODUCTION's live catalog read-only.
-- Status:  REVIEW BEFORE RUNNING. Not a migration on purpose — see "Why not a
--          migration" below. Nothing here has been applied to any project yet.
--
-- -----------------------------------------------------------------------------
-- WHAT HAPPENED
-- -----------------------------------------------------------------------------
-- Every grant in staging's `public` schema was removed. Not drifted — removed:
--
--   staging   pg_namespace.nspacl for 'public'  = NULL   (owner-only)
--   staging   tables SELECT-able by service_role/authenticated/anon = 0 of 308
--   staging   remaining grants = exactly 7 privileges x 308 tables = owner only
--
--   production  nspacl = pg_database_owner=UC | =U | postgres=U | anon=U
--                        | authenticated=U | service_role=U
--   production  tables SELECT-able: service_role 309/309, authenticated 150,
--               anon 97
--
-- Timeline (UTC), from CI history + staging's own audit_logs:
--   2026-07-30 07:33:44   Migration Drift Check SUCCEEDS  -> staging healthy
--   2026-07-30 08:10:04   last successful write to staging public.audit_logs
--   2026-07-30 08:13:34   Drift Check FAILS: "permission denied for schema public"
--   2026-07-31 (ongoing)  still failing; staging DB unreachable by every app role
--
-- No migration in this repo performs this revoke. Every schema-level revoke in
-- supabase/ targets `internal`, `private`, `backup`, `vault`, or
-- `sos_merge_undo_20260728` — never `public`. Production has the identical
-- migration set applied and is fully healthy. The change was therefore made
-- OUT OF BAND against staging (manual SQL, MCP call, or dashboard action).
--
-- Most likely shape, recorded as hypothesis not fact: a hardening statement of
-- the form `revoke all on schema <X> from public, anon, authenticated` fired
-- with X = public, or against the wrong project_id. AGENTS.md already warns:
-- "the project_id argument is the only thing separating staging from production."
--
-- PRODUCTION WAS NOT AFFECTED and is verified healthy (309/309 service_role
-- grants; migration drift check against production returns OK).
--
-- -----------------------------------------------------------------------------
-- WHY NOT A MIGRATION
-- -----------------------------------------------------------------------------
-- A file in supabase/migrations/ runs against every project, forever, and would
-- freeze one day's grant snapshot into the permanent schema history — so a
-- deliberate future REVOKE could be silently undone by a replay. This is a
-- one-time environment repair, so it lives with the other historical repair
-- scripts at the supabase/ root (see CLAUDE.md) and is run deliberately, once.
--
-- -----------------------------------------------------------------------------
-- SAFETY
-- -----------------------------------------------------------------------------
--  * Idempotent. Every statement is GRANT-only; nothing is revoked or dropped.
--  * Self-guarding. The block below ABORTS if service_role already holds USAGE
--    on public — i.e. on a healthy database (production) this is a no-op that
--    refuses to run, so it cannot widen access anywhere that isn't broken.
--  * Grants are permission to *reach* a table; RLS still decides which rows are
--    visible. Restoring these does not weaken any RLS policy.
--  * Derived by transcription from production's catalog, not by judgement: the
--    table lists below are production's exact sets as of 2026-07-31, with one
--    documented subtraction (below). Each list was machine-verified against
--    production's counts (97 / 139 / 8 / 3) and every name checked to exist on
--    staging before this file was finalised.
--
-- ONE DELIBERATE DIFFERENCE FROM PRODUCTION:
--   public.email_backfill_backup_20260730 exists on production (309 relations)
--   but NOT on staging (308). It is a one-off backup table from the 2026-07-30
--   email backfill. It is omitted from the anon and authenticated lists below,
--   because GRANT on a non-existent relation aborts the whole transaction and
--   would leave staging exactly as broken as it is now. Staging therefore ends
--   at 96 anon / 149 authenticated relations, not 97 / 150 — correct, since the
--   309th relation simply is not there.
--
-- Verify afterwards with the query at the bottom of this file. Expected on
-- STAGING: service_role 308, authenticated 149, anon 96 (production's numbers
-- minus that single absent backup table).
-- =============================================================================

begin;

-- --- Guard: refuse to run against a database that is not damaged --------------
do $$
begin
  if has_schema_privilege('service_role', 'public', 'USAGE') then
    raise exception
      'REFUSING TO RUN: service_role already has USAGE on schema public, so this '
      'database is not the damaged one. This repair script is for the wiped '
      'STAGING project only. Nothing has been changed.';
  end if;
end
$$;

-- --- 1. Schema-level USAGE (matches production's nspacl) ----------------------
grant usage on schema public to public;
grant usage on schema public to postgres;
grant usage on schema public to anon;
grant usage on schema public to authenticated;
grant usage on schema public to service_role;

-- --- 2. service_role: full privileges on everything (production: 309/309) -----
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute          on all functions in schema public to service_role;

-- --- 3. Sequences: USAGE for anon + authenticated (production: 58 each) -------
grant usage on all sequences in schema public to anon;
grant usage on all sequences in schema public to authenticated;

-- --- 4. anon: all 7 table privileges on production's exact 97 relations -------
--     (84 tables + 13 views). RLS is what actually constrains anon at runtime.
grant all privileges on table
  app_error_events, ats_candidate_cv_extractions, ats_cv_intake_events,
  ats_email_intake_cursors, ats_whatsapp_inbound_messages, background_jobs,
  blocked_ips, direct_order_approval_steps, direct_order_caps,
  direct_order_events, direct_order_pharmacies,
  direct_order_pharmacy_distributor_codes, direct_order_requests,
  employee_linkage_health,
  employee_linkage_health_summary, employee_plan_visit_details,
  geo_locations_brick_centroid_backup2_20260728,
  geo_locations_brick_centroid_backup_20260728, ireports360_visits_effective,
  marketing_control_settings, marketing_customer_contacts,
  marketing_customer_pharmacies, marketing_customers, marketing_distributors,
  marketing_evidence_files, marketing_pharmacies,
  marketing_pharmacy_code_references, marketing_pharmacy_distributor_codes,
  marketing_products, marketing_request_approval_steps,
  marketing_request_finance_requirements, marketing_request_pharmacies,
  marketing_request_products, marketing_request_types, marketing_requests,
  marketing_review_routing, marketing_workflow_steps,
  monthly_closing_publications, notification_role_policies,
  notification_send_reviews, payroll_copilot_adjustments,
  payroll_copilot_expense_decisions, payroll_copilot_flags,
  payroll_copilot_runs, payroll_copilot_vacation_settlements,
  payroll_recurring_adjustments, payroll_resignation_candidates,
  payroll_statutory_config, pm_product_assignments,
  private_calendar_data_disputes, private_calendar_no_activity_clarifications,
  probation_assessments, probation_cases, probation_config,
  probation_development_actions, probation_dv_days, probation_dv_ingest_issues,
  probation_dv_visits, probation_feedback, probation_feedback_comments,
  probation_feedback_submissions, probation_feedback_versions,
  probation_provisioning_failures, push_subscriptions, report_it_audit_logs,
  report_it_dashboard_access, report_it_reports, sales_employee_linkage_health,
  sales_employee_linkage_health_summary, sales_target_batches, sales_targets,
  sos_import_coverage_snapshots, source_of_sales_block_groups,
  source_of_sales_customer_map, source_of_sales_distributor_certification,
  source_of_sales_mapping_audit, thread_members, threads, v_active_organogram,
  v_employee_portal_payslips, v_employee_portal_salary_history,
  v_employee_portal_sales, v_employee_portal_sales_filters,
  v_hr_id_orphan_audit, v_payroll_eligible_employees, weekly_sales_batches,
  weekly_sales_branch_region_map, weekly_sales_pos_region_mappings,
  weekly_sales_product_aliases, weekly_sales_product_scope, weekly_sales_rows,
  workflow_audit_logs, workflow_definitions, workflow_drafts,
  workflow_publish_history, workflow_versions
to anon;

-- --- 5. authenticated tier A: all 7 privileges on 139 relations ---------------
grant all privileges on table
  app_error_events, ats_candidate_cv_extractions, ats_cv_intake_events,
  ats_email_intake_cursors, ats_whatsapp_inbound_messages,
  automated_payroll_audit, automated_payroll_carry_forward,
  automated_payroll_draft_rows, automated_payroll_non_employees,
  automated_payroll_runs, automated_payroll_step_state, background_jobs,
  blocked_ips, brick_reference_imports, brick_reference_rows,
  direct_order_approval_steps, direct_order_caps, direct_order_events,
  direct_order_pharmacies, direct_order_pharmacy_distributor_codes,
  direct_order_requests,
  employee_linkage_health, employee_linkage_health_summary, employee_locations,
  employee_plan_visit_details, geo_bricks, geo_locations,
  geo_locations_brick_centroid_backup2_20260728,
  geo_locations_brick_centroid_backup_20260728, geo_trip_routes,
  ireports360_visits_effective, marketing_control_settings,
  marketing_customer_contacts, marketing_customer_pharmacies,
  marketing_customers, marketing_distributors, marketing_evidence_files,
  marketing_pharmacies, marketing_pharmacy_code_references,
  marketing_pharmacy_distributor_codes, marketing_products,
  marketing_request_approval_steps, marketing_request_finance_requirements,
  marketing_request_pharmacies, marketing_request_products,
  marketing_request_types, marketing_requests, marketing_review_routing,
  marketing_workflow_steps, monthly_closing_publications,
  notification_role_policies, notification_send_reviews,
  outstation_expense_requests, outstation_policy_rules,
  payroll_copilot_adjustments, payroll_copilot_expense_decisions,
  payroll_copilot_flags, payroll_copilot_runs,
  payroll_copilot_vacation_settlements, payroll_recurring_adjustments,
  payroll_resignation_candidates, payroll_statutory_config,
  pm_product_assignments, private_calendar_data_disputes,
  private_calendar_no_activity_clarifications, probation_assessments,
  probation_cases, probation_config, probation_development_actions,
  probation_dv_days, probation_dv_ingest_issues, probation_dv_visits,
  probation_feedback, probation_feedback_comments,
  probation_feedback_submissions, probation_feedback_versions,
  probation_provisioning_failures, push_subscriptions, report_it_audit_logs,
  report_it_dashboard_access, report_it_reports, sales_area_region_codes,
  sales_distributor_codes, sales_employee_linkage_health,
  sales_employee_linkage_health_summary, sales_ops_dashboard_snapshot,
  sales_ops_distributor_profile, sales_ops_rollup_area_product,
  sales_ops_rollup_by_area, sales_ops_rollup_by_brick,
  sales_ops_rollup_by_distributor, sales_ops_rollup_by_line,
  sales_ops_rollup_by_product, sales_ops_rollup_by_region,
  sales_ops_rollup_leaf, sales_ops_rollup_period, sales_product_codes,
  sales_target_batches, sales_targets, sensitive_data_access_audit,
  sos_import_coverage_snapshots, source_of_sales_area_aliases,
  source_of_sales_area_regions, source_of_sales_areas,
  source_of_sales_block_groups, source_of_sales_blocks, source_of_sales_bricks,
  source_of_sales_customer_map, source_of_sales_distributor_certification,
  source_of_sales_distributors, source_of_sales_mapping_audit,
  source_of_sales_product_aliases, source_of_sales_products,
  source_of_sales_region_aliases, source_of_sales_regions,
  source_of_sales_territory_aliases, thread_members, threads,
  v_access_identity_health, v_active_organogram, v_employee_locations_masked,
  v_employee_portal_payslips, v_employee_portal_salary_history,
  v_employee_portal_sales, v_employee_portal_sales_filters,
  v_hr_id_orphan_audit, v_payroll_eligible_employees, weekly_sales_batches,
  weekly_sales_branch_region_map, weekly_sales_pos_region_mappings,
  weekly_sales_product_aliases, weekly_sales_product_scope, weekly_sales_rows,
  workflow_audit_logs, workflow_definitions, workflow_drafts,
  workflow_publish_history, workflow_versions
to authenticated;

-- --- 6. authenticated tier B: DML only, deliberately NO structural rights -----
--     These are the PII / payroll tables. Production withholds REFERENCES,
--     TRIGGER and TRUNCATE here; that asymmetry is the product of the RLS
--     hardening work and is reproduced exactly rather than rounded up to ALL.
grant select, insert, update, delete on table
  employee_compensation, employees, outstation_expense_reports,
  outstation_expenses, salary_batches, salary_flags, salary_records,
  user_access_profiles
to authenticated;

-- --- 7. authenticated tier C: read-only ---------------------------------------
grant select on table
  sales_records, source_of_sales_distributor_profile,
  weekly_sales_distributor_column_profile
to authenticated;

-- --- 8. Functions ------------------------------------------------------------
--     Production exposes exactly 20 functions to PUBLIC (which is how anon can
--     reach them — anon holds no direct routine grants), plus a direct grant to
--     authenticated for the access-context helper family that RLS policies call.
grant execute on function
  public.email_templates_set_updated_at(),
  public.employee_support_requests_touch(),
  public.fill_salary_allowances(),
  public.fn_get_admin_command_center_data(text, text, text),
  public.fn_get_audit_module_counts(),
  public.fn_get_broken_auth_accounts(),
  public.fn_get_command_center_metrics(),
  public.fn_get_employee_directory_paginated(text, bigint, bigint, bigint, bigint, text, integer, integer, text, text, text),
  public.fn_get_employee_hierarchy(text),
  public.generate_report_it_number(),
  public.phx_assert_master_brick_in_block(),
  public.phx_coaching_item_definition(text),
  public.phx_coaching_zone(numeric),
  public.phx_marketing_roi_health(),
  public.protect_base_salary(),
  public.report_it_set_updated_at(),
  public.set_coaching_updated_at(),
  public.set_sidebar_module_assignments_updated_at(),
  public.touch_updated_at(),
  public.workflow_versions_block_mutation()
to public;

grant execute on function
  public.api_rate_limit_consume(text, integer, integer),
  public.current_access_can_manage_employees(),
  public.current_access_can_manage_payroll(),
  public.current_access_can_see_employee(text, text),
  public.current_access_hr_id(),
  public.current_access_is_admin(),
  public.current_access_is_company_reader(),
  public.current_access_is_finance(),
  public.current_access_is_hr(),
  public.current_access_is_super_admin(),
  public.current_access_line(),
  public.current_access_manager_hr_id(),
  public.current_access_role(),
  public.current_access_scope(),
  public.current_phoenix_role(),
  public.phx_sync_sales_pharmacy_codes_into_marketing()
to authenticated;

-- --- 9. The CI drift-check RPC's own grants (see 20260720000000) --------------
--     Re-asserted explicitly: this is the call that has been failing since the
--     wipe, and it depends on a grant OUTSIDE schema public.
grant usage  on schema supabase_migrations              to service_role;
grant select on supabase_migrations.schema_migrations   to service_role;
grant execute on function public.phx_ci_migration_versions() to service_role;

notify pgrst, 'reload schema';

commit;

-- =============================================================================
-- VERIFICATION — run after applying. Expected ON STAGING:
--   svc_usage=t  authd_usage=t  anon_usage=t
--   svc_tables=308  authd_tables=149  anon_tables=96
-- (Production reads 309 / 150 / 97 — the difference is the single absent
--  email_backfill_backup_20260730 relation documented in the header.)
-- =============================================================================
-- select
--   has_schema_privilege('service_role','public','USAGE')   as svc_usage,
--   has_schema_privilege('authenticated','public','USAGE')  as authd_usage,
--   has_schema_privilege('anon','public','USAGE')           as anon_usage,
--   count(*) filter (where has_table_privilege('service_role',  c.oid,'SELECT')) as svc_tables,
--   count(*) filter (where has_table_privilege('authenticated', c.oid,'SELECT')) as authd_tables,
--   count(*) filter (where has_table_privilege('anon',          c.oid,'SELECT')) as anon_tables
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind in ('r','p','v');
