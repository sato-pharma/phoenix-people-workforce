-- Rollup-completion (PR 2): rebuild source_of_sales_customer_directory_rollup under its
-- widened grain (is_direct split out, official_line picked). Every existing row predates
-- the is_direct dimension and must be fully regenerated, not patched in place — this is
-- the same full delete-then-reinsert the table already uses for its normal backfill path,
-- just re-run once against the new function body from the prior migration.
select public.phx_backfill_sos_customer_directory_rollup();
