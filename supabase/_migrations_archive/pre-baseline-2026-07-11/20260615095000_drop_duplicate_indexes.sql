-- ============================================================================
-- Drop redundant duplicate indexes
-- ----------------------------------------------------------------------------
-- Finding (Low/Medium, performance advisor duplicate_index): 3 pairs of
-- byte-for-byte identical indexes. Each pair costs double maintenance on every
-- write. Verified via pg_index/pg_get_indexdef on production
-- (ref ozucdzovmcqvepbozvqf); in each pair we keep the constraint-backed
-- (or canonical) index and drop the plain duplicate.
--
--   1) email_notification_policies(notification_type):
--        keep email_notification_policies_pkey (PRIMARY KEY),
--        drop email_notification_policies_notification_type_uidx
--   2) permissions(resource, action):
--        keep permissions_resource_action_unique (UNIQUE constraint-backed),
--        drop permissions_resource_action_uidx
--   3) source_of_sales_import_rows — the high-value one (~52MB combined on the
--      ~109k-row hottest sales table; halves write/index-maintenance cost):
--        keep sos_rows_directory_covering_idx,
--        drop sos_rows_directory_cov2_idx (identical partial covering index)
--
-- Note: v2_vacation_requests has two near-identical manager indexes that differ
-- only in created_at sort direction (DESC vs ASC); the advisor does NOT flag
-- them as duplicates and both can serve real ordering, so they are LEFT ALONE.
-- Reversible: re-create from the kept index definition.
-- ============================================================================

drop index if exists public.email_notification_policies_notification_type_uidx;
drop index if exists public.permissions_resource_action_uidx;
drop index if exists public.sos_rows_directory_cov2_idx;
