-- index_unindexed_foreign_keys — every foreign key in public gets an index that leads with its columns
--
-- WHAT THIS CHANGES:
--   59 btree indexes, one per foreign key the database advisor reported as having no covering index
--   (lint unindexed_foreign_keys, read on production 2026-11-13 at 17:33 Cairo). Each leads with
--   exactly the key's columns, in the key's order. No table, column, constraint, row or grant changes.
--
-- WHY (enterprise audit 2026-11-13, F-DB-006, S03):
--   Postgres checks a foreign key from the PARENT's side too. Deleting, merging or renaming the parent
--   row has to find every child row that names it, and with no index that is a scan of the whole child
--   table per parent row. The audit counted 41. The count was 59 by the time this was written: the 21
--   keys to employees(hr_id) added earlier today (20261113160008, 20261113160747, 20261113161558) came
--   without an index, and ON UPDATE CASCADE means every hr_id change walked each of those tables.
--   The audit's own fix indexes only the tables above a few thousand rows. This indexes all 59, because
--   on an empty or small table the index costs nothing to keep, and a clean advisor means the next
--   unindexed key is visible the day it is added.
--
-- MEASURED 2026-11-13 (read-only), before this was written:
--   The largest children are source_of_sales_customer_map (105,577 rows), automated_payroll_draft_cell_history
--   (6,160) and hr_ops_report_lines (4,436). 43 of the 59 keys sit on a table of fewer than 10 rows, 33 of
--   them on an empty one (pg_stat_user_tables n_live_tup).
--   No name below was taken.
--
-- PRODUCTION: the three largest were created CONCURRENTLY by hand first, so no write waited on the
-- lock a plain CREATE INDEX takes. CONCURRENTLY cannot run inside a transaction and migrations do, so
-- the statements below are the plain form, guarded by IF NOT EXISTS: a no-op where the index already
-- exists, and correct for staging and for any database rebuilt from migrations. Every name is new
-- (checked), so IF NOT EXISTS can never skip a statement on a name that belongs to some other index.
--
-- ROLLBACK:
--   drop index if exists public.<name>; for each name below. Nothing else is created.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration changes no application data: an index changes how a row is found, never which rows
-- a query returns.

begin;
set local lock_timeout = '5s';

-- Keys to public.employees(hr_id) — the 21 that the employee-key migrations added without an index.
create index if not exists app_auth_users_test_persona_of_hr_id_fk_idx
  on public.app_auth_users (test_persona_of_hr_id);
create index if not exists attendance_annual_balance_charges_employee_hr_id_fk_idx
  on public.attendance_annual_balance_charges (employee_hr_id);
create index if not exists automated_payroll_carry_forward_employee_hr_id_fk_idx
  on public.automated_payroll_carry_forward (employee_hr_id);
create index if not exists automated_payroll_draft_cell_history_employee_hr_id_fk_idx
  on public.automated_payroll_draft_cell_history (employee_hr_id);
create index if not exists automated_payroll_draft_rows_employee_hr_id_fk_idx
  on public.automated_payroll_draft_rows (employee_hr_id);
create index if not exists automated_payroll_held_entered_employee_hr_id_fk_idx
  on public.automated_payroll_held_entered (employee_hr_id);
create index if not exists automated_payroll_held_part1_unpaid_employee_hr_id_fk_idx
  on public.automated_payroll_held_part1_unpaid (employee_hr_id);
create index if not exists automated_payroll_held_releases_employee_hr_id_fk_idx
  on public.automated_payroll_held_releases (employee_hr_id);
create index if not exists automated_payroll_held_settlements_employee_hr_id_fk_idx
  on public.automated_payroll_held_settlements (employee_hr_id);
create index if not exists automated_payroll_standing_additions_employee_hr_id_fk_idx
  on public.automated_payroll_standing_additions (employee_hr_id);
create index if not exists crm_contact_list_changes_decided_by_fk_idx
  on public.crm_contact_list_changes (decided_by);
create index if not exists crm_contact_list_changes_requested_by_fk_idx
  on public.crm_contact_list_changes (requested_by);
create index if not exists crm_native_visit_vacation_day_requests_hr_decided_by_fk_idx
  on public.crm_native_visit_vacation_day_requests (hr_decided_by);
create index if not exists daily_deductions_lines_employee_hr_id_fk_idx
  on public.daily_deductions_lines (employee_hr_id);
create index if not exists deductions_candidates_employee_hr_id_fk_idx
  on public.deductions_candidates (employee_hr_id);
create index if not exists deductions_publication_lines_employee_hr_id_fk_idx
  on public.deductions_publication_lines (employee_hr_id);
create index if not exists dispute_refunds_employee_hr_id_fk_idx
  on public.dispute_refunds (employee_hr_id);
create index if not exists outstation_expense_requests_medical_trip_hr_id_fk_idx
  on public.outstation_expense_requests (medical_trip_hr_id);
create index if not exists payroll_copilot_expense_decisions_employee_hr_id_fk_idx
  on public.payroll_copilot_expense_decisions (employee_hr_id);
create index if not exists payroll_copilot_flags_employee_hr_id_fk_idx
  on public.payroll_copilot_flags (employee_hr_id);
create index if not exists payroll_copilot_vacation_settlements_employee_hr_id_fk_idx
  on public.payroll_copilot_vacation_settlements (employee_hr_id);

-- Every other key.
create index if not exists ats_interview_zoom_polls_poll_set_id_fk_idx
  on public.ats_interview_zoom_polls (poll_set_id);
create index if not exists ats_mr_hiring_recommendations_booking_id_fk_idx
  on public.ats_mr_hiring_recommendations (booking_id);
create index if not exists ats_mr_hiring_step_results_booking_id_fk_idx
  on public.ats_mr_hiring_step_results (booking_id);
create index if not exists ats_whatsapp_template_sends_template_id_fk_idx
  on public.ats_whatsapp_template_sends (template_id);
create index if not exists automated_payroll_held_entered_recorded_in_run_id_fk_idx
  on public.automated_payroll_held_entered (recorded_in_run_id);
create index if not exists automated_payroll_held_part1_unpaid_recorded_in_run_id_fk_idx
  on public.automated_payroll_held_part1_unpaid (recorded_in_run_id);
create index if not exists automated_payroll_non_employees_recurring_id_fk_idx
  on public.automated_payroll_non_employees (recurring_id);
create index if not exists crm_contact_list_changes_contact_crm_id_fk_idx
  on public.crm_contact_list_changes (contact_crm_id);
create index if not exists daily_deductions_disputes_category_fk_idx
  on public.daily_deductions_disputes (category);
create index if not exists daily_deductions_lines_category_fk_idx
  on public.daily_deductions_lines (category);
create index if not exists daily_deductions_pubs_superseded_by_publication_id_fk_idx
  on public.daily_deductions_publications (superseded_by_publication_id);
create index if not exists deductions_publication_lines_superseded_by_line_id_fk_idx
  on public.deductions_publication_lines (superseded_by_line_id);
create index if not exists hiring_document_files_document_id_fk_idx
  on public.hiring_document_files (document_id);
create index if not exists hiring_pack_custom_templates_superseded_by_fk_idx
  on public.hiring_pack_custom_templates (superseded_by);
create index if not exists hr_ops_report_lines_carried_from_line_id_fk_idx
  on public.hr_ops_report_lines (carried_from_line_id);
create index if not exists hr_reminder_comments_reply_to_id_fk_idx
  on public.hr_reminder_comments (reply_to_id);
create index if not exists hr_retention_conversations_resignation_id_fk_idx
  on public.hr_retention_conversations (resignation_id);
create index if not exists market_awareness_activities_activity_type_id_fk_idx
  on public.market_awareness_activities (activity_type_id);
create index if not exists market_awareness_activities_primary_line_id_fk_idx
  on public.market_awareness_activities (primary_line_id);
create index if not exists market_awareness_activity_approvers_line_id_fk_idx
  on public.market_awareness_activity_approvers (line_id);
create index if not exists market_awareness_activity_lines_line_id_fk_idx
  on public.market_awareness_activity_lines (line_id);
create index if not exists market_awareness_activity_products_line_id_fk_idx
  on public.market_awareness_activity_products (line_id);
create index if not exists mkt_cust_do_transfers_direct_order_validation_id_fk_idx
  on public.marketing_customer_direct_order_transfers (direct_order_validation_id);
create index if not exists mkt_cust_do_transfers_marketing_pharmacy_id_fk_idx
  on public.marketing_customer_direct_order_transfers (marketing_pharmacy_id);
create index if not exists marketing_customer_list_checks_line_id_fk_idx
  on public.marketing_customer_list_checks (line_id);
create index if not exists marketing_distributors_merged_into_distributor_id_fk_idx
  on public.marketing_distributors (merged_into_distributor_id);
create index if not exists marketing_pharmacy_direct_order_venues_customer_id_fk_idx
  on public.marketing_pharmacy_direct_order_venues (customer_id);
create index if not exists offers_template_id_fk_idx
  on public.offers (template_id);
create index if not exists prodplan_alarm_events_material_id_fk_idx
  on public.prodplan_alarm_events (material_id, unit_kind);
create index if not exists prodplan_expiry_events_material_id_fk_idx
  on public.prodplan_expiry_events (material_id, unit_kind);
create index if not exists prodplan_material_prices_material_id_fk_idx
  on public.prodplan_material_prices (material_id, unit_kind);
create index if not exists prodplan_run_materials_material_id_fk_idx
  on public.prodplan_run_materials (material_id, unit_kind);
create index if not exists prodplan_stock_entries_material_id_fk_idx
  on public.prodplan_stock_entries (material_id, unit_kind);
create index if not exists sos_map_change_holds_log_id_fk_idx
  on public.sos_map_change_holds (log_id);
create index if not exists source_of_sales_brick_move_files_batch_id_fk_idx
  on public.source_of_sales_brick_move_files (batch_id);
create index if not exists source_of_sales_bricks_superseded_by_brick_id_fk_idx
  on public.source_of_sales_bricks (superseded_by_brick_id);
create index if not exists source_of_sales_customer_map_brick_id_fk_idx
  on public.source_of_sales_customer_map (brick_id, area_code, region_code);
create index if not exists visual_aids_superseded_by_fk_idx
  on public.visual_aids (superseded_by);

commit;
