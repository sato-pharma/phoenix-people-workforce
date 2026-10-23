-- move_dated_backup_tables_out_of_public
--
-- WHAT THIS CHANGES: moves the 70 dated backup / pre-image tables that sat in `public` on
--   production into 16 dated backup schemas (<domain>_backup_YYYYMMDD), keeping every table's
--   name, rows, RLS state and grants. `alter table ... set schema` relocates the table; no row is
--   read, rewritten or deleted. Measured on production before applying (23 Oct 2026, ~02:40
--   Cairo): 70 tables, 21,308 rows, none readable by anon or authenticated, and no view, foreign
--   key, function body or pg_cron job naming any of them. Code mentions are comments only.
-- WHY: `public` is the one schema PostgREST serves. These tables were the whole of the
--   `snapshot_table_in_public` error (70) and most of the `missing_primary_key` error (75) that
--   the daily Migration Drift Check has raised on production every night since 1 Oct 2026.
--   docs/security/backup-table-placement.md: a snapshot goes in its own dated schema, never
--   in public; and the retention sweep ages a backup by its schema's date.
-- STAGING: none of these tables exists there (staging was cloned 29 Aug 2026), so every move is
--   skipped by the to_regclass guard and the migration is a no-op on staging.
-- ROLLBACK: per table, `alter table <schema>.<name> set schema public;` then
--   `drop schema <schema>;` once it is empty. Nothing is lost either way.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

do $$
declare
  m record;
begin
  for m in
    select * from (values
      ('address_brick_import_rows_backup_20261013', 'address_brick_backup_20261013'),
      ('address_brick_map_backup_20261013', 'address_brick_backup_20261013'),
      ('crm_backup_20261001_aug_leave_preimage', 'crm_backup_20261001'),
      ('crm_backup_20261001_b185_settlement_preimage', 'crm_backup_20261001'),
      ('crm_backup_20261001_sept_leave_preimage', 'crm_backup_20261001'),
      ('crm_backup_20261003_test_aa_walkthrough_preimage', 'crm_backup_20261003'),
      ('ep_bk_202609_backup_20261009_batch', 'ep_backup_20261009'),
      ('ep_bk_202609_backup_20261009_factrollup', 'ep_backup_20261009'),
      ('ep_bk_202609_backup_20261009_prodrollup', 'ep_backup_20261009'),
      ('ep_bk_202609_backup_20261009_rows', 'ep_backup_20261009'),
      ('ep_bk_202609_backup_20261009_summaries', 'ep_backup_20261009'),
      ('epda_22198955_split_backup_20261010', 'epda_backup_20261010'),
      ('epda_sep_split_backup_20261010', 'epda_backup_20261010'),
      ('epda_22199672_split_backup_20261009', 'epda_backup_20261009'),
      ('hiring_document_definitions_pre_20260930', 'hiring_backup_20260930'),
      ('msn_202609_backup_20261009', 'msn_backup_20261009'),
      ('msn_202609_backup_20261010', 'msn_backup_20261010'),
      ('phx_backup_20261012_b161_duplicate_venues', 'phx_backup_20261012'),
      ('phx_backup_20261012_duplicate_venues_8_seats', 'phx_backup_20261012'),
      ('phx_backup_20261017_testrest_customers', 'phx_backup_20261017'),
      ('phx_backup_20261017_testrest_list_events', 'phx_backup_20261017'),
      ('phx_backup_20261017_testrest_list_requests', 'phx_backup_20261017'),
      ('phx_backup_20261017_testrest_manager_customers', 'phx_backup_20261017'),
      ('phx_backup_20261017_testrest_places', 'phx_backup_20261017'),
      ('phx_backup_20261017_testrest_shared_places', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_behaviour_integrity', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_daily_forecasts', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_day_activities', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_day_starts', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_double_visit_plans', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_location_integrity', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_manager_plan_customers', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_manager_plan_edit_requests', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_manager_plan_events', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_manager_plan_slots', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_manager_plans', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_manager_visits', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_monthly_plan_events', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_monthly_plans', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_photo_fingerprints', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_photo_uploads', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plan_activities', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plan_day_starts', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plan_edit_request_events', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plan_edit_requests', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plan_events', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plan_items', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_plans', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_refused_readings', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_removed_visits', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_time_anchors', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_touch_trail', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_unplanned_visit_events', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_unplanned_visits', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_validation_reviews', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_visit_asks', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_visit_capture_provenance', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_visit_edits', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_visit_recordings', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_visits', 'phx_backup_20261017'),
      ('phx_backup_20261017_testwork_voice_uploads', 'phx_backup_20261017'),
      ('phx_crm_place_brick_backup_20261010', 'phx_crm_backup_20261010'),
      ('sohag_city_kept10_backup_20261009', 'sohag_backup_20261009'),
      ('sohag44_map_backup_20261009', 'sohag_backup_20261009'),
      ('sohag45th_map_backup_20261009', 'sohag_backup_20261009'),
      ('sohag8_map_backup_20261009', 'sohag_backup_20261009'),
      ('sos_backup_20261002_qm_directory_effective_units', 'sos_backup_20261002'),
      ('store_split_net_backup_20261013b', 'store_split_backup_20261013'),
      ('weekly_plan_oct8_backup_20261002', 'weekly_plan_backup_20261002'),
      ('weekly_plan_oct8_items_backup_20261002', 'weekly_plan_backup_20261002')
    ) as v(tbl, sch)
  loop
    if to_regclass(format('public.%I', m.tbl)) is null then
      continue;
    end if;
    execute format('create schema if not exists %I', m.sch);
    execute format('revoke all on schema %I from public, anon, authenticated', m.sch);
    execute format('alter table public.%I set schema %I', m.tbl, m.sch);
  end loop;
end
$$;

commit;

-- Timestamp 20261023023133 was minted to sort after every migration already on main.
