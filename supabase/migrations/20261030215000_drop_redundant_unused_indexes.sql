-- Drop 46 indexes that another index on the same table already answers.
--
-- WHY. The daily drift check counts `unused_index` (idx_scan = 0, not unique, not a primary key,
-- not backing a constraint) against the accepted 755. On 2026-10-30 it read 772 on counters 34 hours
-- old (the 29 Oct crash restart zeroed them), and from 2 Nov, when the counters pass 96 hours, a
-- reading over 755 fails the run. The baseline doc says this count is NOT a drop list, because a
-- zero scan count never proves a low-frequency path is dead. These 46 are different: each one is
-- REDUNDANT, not merely unread. Every one is an exact duplicate, or a leading-column prefix, of
-- another index on the same table that stays, with the same access method, operator classes,
-- collations, sort directions and partial predicate. Postgres answers any lookup the dropped index
-- could answer from the one that stays, so no query loses its index. Each still costs a write on
-- every insert and update.
--
-- HOW THE LIST WAS CHOSEN (production, read 2026-10-30 ~23:45 Cairo). Plain b-tree, no expression,
-- no INCLUDE columns, idx_scan = 0, and a covering index that is unique, a primary key, backs a
-- constraint, has been scanned, or is strictly wider. Supabase-managed schemas are out of scope.
-- Deliberately KEPT although they match:
--   - ireports360_visits_agent_crm_id_idx and perf_ireports360_visits_agent_hr_id_visit_date_crm —
--     the owner declined dropping them on 2026-10-28 (.claude/rules/crm-unified-doors.md).
--   - idx_salary_structure_effective and idx_salary_structure_hr_id — the 2026-06 performance
--     migration kept the first on purpose (tests/phase21-security-hardening.test.ts); payroll is
--     left alone.
--   - six whose sort direction differs from their cover (indoption), which a mixed-direction
--     ORDER BY could need.
--
-- SAFETY. No data is touched; each index can be rebuilt with one create index statement. Each drop
-- runs only when its named cover still exists and is valid, so a database whose indexes differ
-- (staging) skips that pair instead of losing its only index. lock_timeout keeps a drop from queueing
-- behind a long read on a busy table.

begin;
set local lock_timeout = '5s';

do $migration$
declare
  pair record;
  dropped integer := 0;
  skipped integer := 0;
begin
  for pair in
    select * from (values
      ('deductions_governance_backup_20260830', 'deduction_decisions_candidate_id_idx', 'deduction_decisions_candidate_unique'),
      ('deductions_governance_backup_20260830', 'deduction_monthly_summary_lines_summary_idx', 'deduction_monthly_summary_lines_unique_decision'),
      ('public', 'area_consolidation_move_consolidation_idx', 'area_consolidation_move_unique'),
      ('public', 'attendance_exceptions_employee_date_idx', 'attendance_exceptions_employee_hr_id_exception_date_key'),
      ('public', 'attendance_holiday_overrides_observed_idx', 'attendance_holiday_overrides_observed_range_idx'),
      ('public', 'attendance_weekly_digests_employee_idx', 'attendance_weekly_digests_employee_week_round_key'),
      ('public', 'automated_payroll_carry_forward_source_idx', 'automated_payroll_carry_forward_source_employee_key'),
      ('public', 'automated_payroll_held_settlements_run_idx', 'automated_payroll_held_settlements_run_employee_idx'),
      ('public', 'automated_payroll_non_employees_run_idx', 'automated_payroll_non_employees_run_part_idx'),
      ('public', 'coaching_score_items_report_id_idx', 'coaching_score_items_report_key_unique'),
      ('public', 'daily_deductions_lines_publication_idx', 'daily_deductions_lines_pub_employee_category_idx'),
      ('public', 'employees_manager_hr_id_idx', 'idx_employees_manager_status'),
      ('public', 'field_workforce_days_import_id_idx', 'field_workforce_days_import_employee_date_idx'),
      ('public', 'field_workforce_decisions_import_id_idx', 'field_workforce_decisions_type_status_idx'),
      ('public', 'field_workforce_summary_import_id_idx', 'field_workforce_summary_hierarchy_idx'),
      ('public', 'hiring_pack_custom_template_pages_order_idx', 'hiring_pack_custom_template_pages_one_per_index'),
      ('public', 'idx_coaching_audit_report', 'coaching_report_audit_logs_report_id_idx'),
      ('public', 'idx_hr_retention_conv_themes_conversation', 'hr_retention_conversation_the_conversation_id_theme_key_sen_key'),
      ('public', 'idx_probation_feedback_versions_feedback', 'probation_feedback_versions_unique'),
      ('public', 'idx_sales_records_batch_id', 'idx_sales_records_batch_values'),
      ('public', 'idx_sales_records_employee_hr_id', 'idx_sales_records_employee_period'),
      ('public', 'market_awareness_activity_bricks_activity_idx', 'market_awareness_activity_bricks_unique'),
      ('public', 'market_awareness_activity_lines_activity_idx', 'market_awareness_activity_lines_unique'),
      ('public', 'market_awareness_activity_products_activity_idx', 'market_awareness_activity_products_unique'),
      ('public', 'marketing_pharmacy_code_refs_distributor_idx', 'marketing_pharmacy_code_refs_norm_lookup_idx'),
      ('public', 'marketing_roi_customer_facts_period_idx', 'marketing_roi_customer_facts_grain_uniq'),
      ('public', 'marketing_roi_distributor_facts_period_idx', 'marketing_roi_distributor_facts_grain_uniq'),
      ('public', 'marketing_roi_filter_presets_owner_idx', 'marketing_roi_filter_presets_owner_kind_name_unique'),
      ('public', 'marketing_roi_line_facts_period_idx', 'marketing_roi_line_facts_grain_uniq'),
      ('public', 'marketing_roi_product_facts_period_idx', 'marketing_roi_product_facts_grain_uniq'),
      ('public', 'marketing_roi_region_facts_period_idx', 'marketing_roi_region_facts_grain_uniq'),
      ('public', 'marketing_roi_request_geo_facts_request_idx', 'marketing_roi_request_geo_facts_grain_uniq'),
      ('public', 'milestone_notice_marks_viewer_window_idx', 'milestone_notice_marks_pkey'),
      ('public', 'notification_event_reads_event_idx', 'notification_event_reads_unique'),
      ('public', 'payroll_copilot_flags_run_idx', 'payroll_copilot_flags_run_status_idx'),
      ('public', 'pm_product_assignments_hr_id_idx', 'pm_product_assignments_hr_id_product_code_key'),
      ('public', 'position_vacancies_department_idx', 'idx_position_vacancies_org'),
      ('public', 'sos_even_split_roster_period_idx', 'sos_even_split_roster_pkey'),
      ('public', 'source_of_sales_blocks_area_code_idx', 'idx_sos_blocks_area_region'),
      ('public', 'source_of_sales_bricks_block_code_idx', 'idx_sos_bricks_block_area_region'),
      ('public', 'source_of_sales_fact_rollup_batch_idx', 'source_of_sales_fact_rollup_grain_uniq'),
      ('public', 'source_of_sales_reference_issues_source_idx', 'source_of_sales_reference_issues_unique_issue_key'),
      ('public', 'source_of_sales_territory_aliases_normalized_alias_idx', 'source_of_sales_territory_aliases_normalized_target_key'),
      ('public', 'v2_vacation_evidence_reviews_request_idx', 'v2_vacation_evidence_reviews_unique_type'),
      ('public', 'weekly_sales_product_scope_hr_id_idx', 'weekly_sales_product_scope_hr_id_product_code_key'),
      ('public', 'weekly_sales_rows_distributor_idx', 'weekly_sales_rows_cycle_idx')
    ) as t(schema_name, drop_name, cover_name)
  loop
    if exists (
         select 1
           from pg_catalog.pg_class d
           join pg_catalog.pg_namespace dn on dn.oid = d.relnamespace
           join pg_catalog.pg_index di on di.indexrelid = d.oid
           join pg_catalog.pg_class c on c.relname = pair.cover_name and c.relnamespace = dn.oid
           join pg_catalog.pg_index ci on ci.indexrelid = c.oid
          where dn.nspname = pair.schema_name
            and d.relname = pair.drop_name
            and ci.indrelid = di.indrelid
            and ci.indisvalid
            and not di.indisunique
            and not di.indisprimary
       ) then
      execute format('drop index %I.%I', pair.schema_name, pair.drop_name);
      dropped := dropped + 1;
    else
      skipped := skipped + 1;
    end if;
  end loop;
  raise notice 'redundant indexes dropped: %, skipped (absent or no valid cover): %', dropped, skipped;
end
$migration$;

commit;
