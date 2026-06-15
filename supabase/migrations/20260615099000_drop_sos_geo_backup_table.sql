-- ============================================================================
-- Drop superseded SoS geography rollback snapshot
-- sos_import_rows_geo_backup_20260615  (APPLIED to prod 2026-06-15)
-- ----------------------------------------------------------------------------
-- public.sos_import_rows_geo_backup_20260615 was the pre-backfill snapshot of
-- each row's old region/area (columns: id, distributor_code, brick_id,
-- old_region_code/name, old_area_code/name), kept as the rollback net for the
-- "brick = geography source of truth" backfill. 33,311 rows, no PK, no policy,
-- referenced by no code or migration.
--
-- Backfill verified correct before dropping (prod ref ozucdzovmcqvepbozvqf):
--   * 108,905 / 108,905 master-matched rows have region AND area equal to the
--     authoritative source_of_sales_bricks master (0 mismatches).
--   * Distinct regions collapsed 45 -> 8 (phantom-region consolidation).
--   * 0 rows with a null brick_id; live table intact at 109,139 rows after drop.
--
-- The snapshot is therefore superseded. This drop is IRREVERSIBLE.
-- ============================================================================

drop table if exists public.sos_import_rows_geo_backup_20260615;
