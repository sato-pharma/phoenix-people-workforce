# Production-Only Migration Versions (no local file)

Captured 2026-07-11, immediately before the baseline-snapshot migration was introduced. These 67 versions are recorded in production's `supabase_migrations.schema_migrations` table but have no corresponding file anywhere in the pre-baseline migration history. Production's own tracking table remains the permanent record of these; this file exists purely for audit-trail completeness alongside the archive.

Most of this list traces to the area/region/line unification feature (shipped, then fully reverted on production, see `20260702203818_area_region_line_unification_schema`/`..._backfill` through `20260707170000_revert_area_region_line_unification` in the archived history) plus assorted iReports360/attendance-digest/marketing-ROI work that landed on production without a matching commit.

| Version | Name |
|---|---|
| 20260627212705 | portal_sales_view_exclude_confidential |
| 20260627233916 | remove_epr_eps_distributors |
| 20260628035907 | weekly_sales_week_tagging |
| 20260628215433 | roi_unmapped_pharmacies_import |
| 20260629173609 | analytics_sos_head_office_lock |
| 20260629174047 | analytics_sos_period_area_head_office_exclusion |
| 20260629175432 | analytics_sos_period_area_head_office_exclusion |
| 20260629185237 | 20260629140000_probation_feedback_module |
| 20260629193951 | 20260629180000_sos_distributor_product_scope_pushdown |
| 20260629194117 | roi_unmapped_pharmacies_import |
| 20260629201215 | backfill_resignation_decision_hr_ids |
| 20260629204654 | backfill_salary_and_sales_batch_approver_hr_ids |
| 20260629211933 | register_epda_bulk_distributor |
| 20260629213018 | register_epda_pharmacies_distributor |
| 20260629213349 | approvals_identity_consolidation |
| 20260629233621 | normalizer_ignore_product_sentinel |
| 20260701231335 | close_bi_confidential_product_leak |
| 20260701235054 | customer_directory_exclude_codes |
| 20260702015727 | sos_distributor_scope_lookup |
| 20260702095649 | rename_office_distributor_to_marcyrl |
| 20260702174607 | sos_brick_customer_head_office_pushdown |
| 20260702203818 | area_region_line_unification_schema |
| 20260702203838 | area_region_line_unification_backfill |
| 20260702220712 | sos_customer_map_confidence_and_backfill |
| 20260703065401 | reconcile_stale_replacement_vacancies |
| 20260703093049 | marketing_roi_attribution_consistency |
| 20260703120946 | synthetic_journey_runs |
| 20260703130558 | ireports360_visits_report |
| 20260703133833 | employee_nickname |
| 20260703150331 | ireports360_checkins |
| 20260703162838 | ireports360_crm_identity_resolutions |
| 20260703164839 | ireports360_visits_crm_id_indexes |
| 20260703170001 | attendance_exceptions_revoke_anon_grants |
| 20260703170017 | attendance_flexible_hours_policy_fields |
| 20260703170156 | attendance_weekly_digest_tables |
| 20260703170223 | attendance_policy_rules_short_hours_event_type |
| 20260703170239 | attendance_digest_flags |
| 20260703170300 | deduction_candidates_short_hours_type |
| 20260703170409 | attendance_missing_punch_verifications |
| 20260703170420 | attendance_holiday_overrides |
| 20260703170433 | attendance_weekly_digests_notification_event |
| 20260703175329 | leave_attachments_bucket_20mb |
| 20260703191300 | field_workforce_compliance_decisions_month_key |
| 20260703191836 | unify_marketing_product_codes_with_sales |
| 20260703200627 | attendance_digest_admin_review_gate |
| 20260703211156 | field_workforce_compliance_live_snapshots |
| 20260703211642 | 20260704090000_attendance_digest_lines_check_in_out |
| 20260703225909 | marketing_coverage_report_preset_kind |
| 20260704060952 | marketing_roi_fast_active_pharmacies_fix |
| 20260704062401 | marketing_roi_request_geo_facts |
| 20260704062524 | marketing_roi_refresh_geo_facts |
| 20260704062726 | marketing_roi_fast_geo_scoped_summary |
| 20260704062952 | marketing_roi_fast_active_pharmacies_geo_scoped |
| 20260704104030 | sos_customer_directory_rollup_add_is_direct_line |
| 20260704104050 | sos_customer_directory_rollup_backfill |
| 20260704104423 | sos_si_exec_functions_read_from_rollup |
| 20260704113900 | outstation_drop_dv_import_fk |
| 20260704113914 | drop_double_visit_tables |
| 20260704132233 | ireports360_visits_sync_runs_diagnostics |
| 20260704145455 | field_workforce_compliance_snapshot_rollup |
| 20260704150511 | marketing_roi_export_audit_coverage_kind |
| 20260704152529 | marketing_request_atomic_bulk_import |
| 20260704172631 | weekly_plans_edit_request |
| 20260704180549 | weekly_plan_decisions_action_check_widen |
| 20260704194208 | resync_gotrue_password_hashes |
| 20260704232129 | marketing_coverage_export_sales_detail |
| 20260705123736 | remove_coaching_report_email_dark_block |
