-- Guarantee exactly ONE validated Source-of-Sales batch per (distributor, month) at the DATABASE level.
--
-- Marketing ROI actuals (phx_marketing_request_roi_actuals) and every Source-of-Sales dashboard sum
-- rows from import batches whose status = 'validated'. Until now nothing at the DB level stopped two
-- validated batches for the same distributor + month from coexisting, so a month's sales could be
-- DOUBLE-COUNTED in ROI/dashboards via:
--   * a race in commitMonthlyUpload (it inserted the new batch, THEN deleted the prior one), or
--   * the "Direct import (skip validation)" path, which inserted with no replace/dedup.
--
-- This partial unique index makes that physically impossible: a second validated batch for a
-- distributor + period now fails fast (SQLSTATE 23505) instead of silently double-counting. The
-- application paths delete the prior month's batch BEFORE inserting the replacement, so normal
-- re-uploads (replace a month) still work — only a genuine duplicate is rejected, and the app maps the
-- 23505 to a clear "already imported for this month — delete it first" message.
--
-- Scope: only status='validated' batches with a real period are constrained. 'blocked' batches and
-- null-period rows are untouched (they never count in ROI/dashboards).
--
-- Pre-checked on production 2026-06-19: zero existing duplicate validated batches, so this index
-- applies cleanly (no rows rejected). Fully reversible — `drop index ...` restores the prior
-- application-only behaviour with no data change.
create unique index if not exists source_of_sales_one_validated_batch_per_period
  on public.source_of_sales_import_batches (distributor_code, period)
  where status = 'validated' and period is not null;
