-- revoke_authenticated_writes_on_public_tables_and_views
--
-- WHAT THIS CHANGES: the signed-in browser role (`authenticated`) loses INSERT, UPDATE and DELETE
-- on the 56 public tables and 7 public views that still granted them. SELECT stays wherever it was
-- granted, so every read the app makes as a signed-in user keeps working. Nothing else changes:
-- no row, no policy, no function. MAINTAIN (vacuum / analyze / reindex, reachable only from a
-- direct SQL session the browser never gets) is left as it is.
--
-- WHY: the 18 Nov 2026 Supabase audit, finding 6. The grants were the residue of an older design in
-- which the browser wrote these tables itself. Today the app writes every one of them through the
-- server's service-role client, and its one signed-in client (`rowSecurityClientFor`,
-- src/lib/supabase/rls-server.ts) only reads. Measured on production before this ran:
--   * pg_stat_statements since 1 Nov 2026 14:03 Cairo: 32 statements as `authenticated`,
--     11,612 calls, 4,357 of them payroll reads, and ZERO inserts, updates, deletes or RPCs;
--   * every call site of rowSecurityClientFor (11, in payroll/service.ts, outstation/expenses.ts
--     and outstation/claims-read.ts) reads, and the two helpers it hands its client to read too.
-- Row-level security gated these writes today (33 tables carry admin or payroll write policies, the
-- other 23 have none or a deny-all one), and the 7 views are security-invoker and not updatable at
-- all, so this removes a second door that nothing uses, not a live path. The write policies stay:
-- without the grant they are unreachable, and dropping them is a separate decision.
-- staging (cifwmndunmlxjhyjugxa) held exactly the same 63 grants.
--
-- ROLLBACK (only if a signed-in write path is ever reintroduced on purpose; prefer the service
-- role): grant the same privileges back, exactly as they were —
--   grant insert on table public.automated_payroll_audit, public.deductions_audit,
--     public.sensitive_data_access_audit to authenticated;
--   grant insert, update, delete on table <every other object listed below> to authenticated;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is a privilege revoke: it touches no data and is undone by the grant above.

begin;

revoke insert, update, delete on table
  public.ats_candidate_cv_extractions,
  public.ats_cv_intake_events,
  public.ats_email_intake_cursors,
  public.automated_payroll_audit,
  public.automated_payroll_carry_forward,
  public.automated_payroll_draft_rows,
  public.automated_payroll_held_part1_unpaid,
  public.automated_payroll_held_releases,
  public.automated_payroll_held_settlements,
  public.automated_payroll_non_employee_recurring,
  public.automated_payroll_non_employees,
  public.automated_payroll_runs,
  public.automated_payroll_standing_additions,
  public.automated_payroll_step_state,
  public.brick_reference_imports,
  public.brick_reference_rows,
  public.daily_deductions_lines,
  public.daily_deductions_publications,
  public.deductions_audit,
  public.deductions_candidates,
  public.deductions_decisions,
  public.deductions_publication_lines,
  public.deductions_publications,
  public.employee_compensation,
  public.geo_locations,
  public.notification_role_policies,
  public.outstation_expense_reports,
  public.outstation_expense_requests,
  public.outstation_expenses,
  public.outstation_policy_rules,
  public.payroll_copilot_adjustments,
  public.payroll_copilot_expense_decisions,
  public.payroll_copilot_flags,
  public.payroll_copilot_runs,
  public.payroll_copilot_vacation_settlements,
  public.payroll_recurring_adjustments,
  public.payroll_resignation_candidates,
  public.payroll_statutory_config,
  public.push_subscriptions,
  public.report_it_dashboard_access,
  public.salary_batches,
  public.salary_flags,
  public.salary_records,
  public.sensitive_data_access_audit,
  public.source_of_sales_area_aliases,
  public.source_of_sales_area_regions,
  public.source_of_sales_areas,
  public.source_of_sales_blocks,
  public.source_of_sales_bricks,
  public.source_of_sales_distributors,
  public.source_of_sales_product_aliases,
  public.source_of_sales_products,
  public.source_of_sales_region_aliases,
  public.source_of_sales_regions,
  public.source_of_sales_territory_aliases,
  public.user_access_profiles
from authenticated;

revoke insert, update, delete on table
  public.employee_linkage_health,
  public.employee_linkage_health_summary,
  public.source_of_sales_block_groups,
  public.v_access_identity_health,
  public.v_employee_portal_payslips,
  public.v_employee_portal_salary_history,
  public.v_hr_id_orphan_audit
from authenticated;

-- Guard: no public table or view may grant a write to a browser role afterwards, and the reads the
-- app makes as a signed-in user must survive. Any failure rolls the whole change back.
do $$
declare
  leftover text;
  t text;
begin
  select string_agg(distinct c.relname || ':' || a.grantee::regrole::text || ':' || a.privilege_type, ', ')
    into leftover
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'm', 'p', 'f')
    and a.grantee in ('authenticated'::regrole, 'anon'::regrole, 0)
    and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if leftover is not null then
    raise exception 'browser roles still hold writes on public objects: %', leftover;
  end if;

  foreach t in array array[
    'salary_records', 'salary_batches', 'salary_flags', 'payroll_resignation_candidates',
    'outstation_expense_reports', 'outstation_expenses', 'outstation_expense_requests', 'expense_claims'
  ] loop
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception 'authenticated lost SELECT on public.% — the signed-in payroll and expense reads need it', t;
    end if;
  end loop;
end $$;

commit;
