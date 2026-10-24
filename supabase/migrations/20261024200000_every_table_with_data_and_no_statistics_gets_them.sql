-- Every table that holds data and has no column statistics gets them, and the three small CRM
-- door tables get an autovacuum threshold they can actually reach.
--
-- `20261024190000_phoenix_crm_team_starts_keeps_its_planner_statistics.sql` fixed ONE table.
-- Measured on production straight afterwards (2026-10-24), the same hole was open across the
-- schema — 532 ordinary `public` tables, and 237 of them with ZERO rows in `pg_stats`:
--
--   * 208 of those 237 have `relpages = 0`. They are EMPTY, and an empty table that HAS been
--     analyzed holds no `pg_stats` rows either — the two are indistinguishable and both are
--     harmless, because a planner estimate of a table with no pages is right whatever it reads.
--     They are deliberately left alone: analyzing them would put them straight back into the
--     same set and make this migration re-do the same work on every run for ever.
--   * 29 hold data and have no statistics at all — 2,328 kB in total, every one a single page:
--     `ats_whatsapp_template_sends`, `attendance_holiday_overrides`, `attendance_settlements`,
--     `automated_payroll_non_employees`, `automated_payroll_runs`, `device_assignments`,
--     `early_birds_national_winners`, `email_suppressions`, `employee_plan_item_return_notes`,
--     `employee_probation`, `leave_notification_attempts`, `leave_request_events`,
--     `milestone_notice_marks`, `offer_job_titles`, `payroll_copilot_vacation_settlements`,
--     `phoenix_crm_visit_asks`, `phoenix_crm_visit_recordings`, `prodplan_alarm_events`,
--     `prodplan_compositions`, `prodplan_product_materials`, `prodplan_products`,
--     `prodplan_stock_entries`, `report_it_reports`, `sidebar_module_assignments`,
--     `source_of_sales_region_aliases`, `v2_vacation_email_tokens`,
--     `weekly_sales_distributor_column_profile`, `whatsapp_ftp_video_thanks`,
--     `whatsapp_inbound_submission_id`.
--
-- Each one of those 29 is read by the planner as 10 pages / 350 rows, the same hard-coded
-- fallback the team starts had. The counts are small today; the estimate is what joins are
-- ordered from, and a wrong estimate on a 6-row table is what makes a nested loop over it look
-- expensive and a hash join over a large table look cheap.
--
-- 🔴 DO NOT MEASURE THIS WITH `reltuples`. Several of those 29 read a plausible `reltuples` with
-- no `pg_stats` behind it, because ANALYZE is only half-transactional (see the 190000 migration):
-- a rolled-back ANALYZE keeps the in-place `pg_class` row estimate and drops the column
-- statistics. `pg_stats` is the only honest signal, and it is what the loop below keys on.
--
-- The three door tables also get the per-table threshold, because they are the ones that stay
-- small for ever and so can never reach the cluster default of 50 modifications:
--   * `phoenix_crm_day_starts`     — one row per rep per working day
--   * `phoenix_crm_manager_visits` — one row per manager accompaniment
--   * `phoenix_crm_visit_edits`    — one row per correction
-- The other 26 do NOT get it, deliberately: a table that later grows into the thousands would
-- then re-analyze itself after every 5 modifications, which costs more than the bad estimate it
-- buys. Any of them that grows will reach the cluster default on its own.
--
-- `reltuples <> 0` in the loop is the second half of the same thought, and it was measured, not
-- reasoned: of the 29, nine hold PAGES but no LIVE ROWS (rows written and later deleted, the
-- pages not yet reclaimed). ANALYZE on one of those produces no `pg_stats` rows at all — there
-- is nothing to describe — so without this clause they would match the loop again on every
-- single run, for ever. `reltuples` is 0 for exactly those nine right after an ANALYZE, -1 for a
-- table never analyzed, and positive for one with rows: the clause keeps the first out and lets
-- the other two in.
--
-- Re-runnable: ALTER ... SET is idempotent, and the loop analyzes only a table that has live
-- rows and still has no statistics — so a second run of this file selects nothing and does
-- nothing.

begin;

alter table if exists public.phoenix_crm_day_starts
  set (autovacuum_analyze_threshold = 5, autovacuum_analyze_scale_factor = 0.0);

alter table if exists public.phoenix_crm_manager_visits
  set (autovacuum_analyze_threshold = 5, autovacuum_analyze_scale_factor = 0.0);

alter table if exists public.phoenix_crm_visit_edits
  set (autovacuum_analyze_threshold = 5, autovacuum_analyze_scale_factor = 0.0);

do $$
declare
  target record;
  analyzed integer := 0;
begin
  for target in
    select c.oid::regclass as ident, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relpersistence = 'p'
       and c.relpages > 0
       and c.reltuples <> 0
       and not exists (
             select 1 from pg_stats g
              where g.schemaname = 'public' and g.tablename = c.relname
           )
     order by c.relname
  loop
    execute format('analyze %s', target.ident);
    analyzed := analyzed + 1;
  end loop;

  raise notice 'analyzed % table(s) that held data with no column statistics', analyzed;
end
$$;

commit;
