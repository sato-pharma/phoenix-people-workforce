-- Close the weekly-sales logical-week duplicate gap (audit finding M7).
--
-- weekly_sales_batches already has a partial unique index on (distributor_code, week_start,
-- template_key) among validated batches, but the de-cumulation engine groups a cycle's weeks by
-- (distributor, cycle_month) and orders them by week_start (see src/lib/sales/weekly/decumulate.ts).
-- cycle_month and week_number are operator-tagged and editable, so two VALIDATED batches for the same
-- (distributor, cycle_month, week_number, template) that carry DIFFERENT week_start dates both pass
-- the existing index and both validate -- inserting a phantom extra week into that cycle's sequence
-- and corrupting the telescoping chain (a "week" whose delta is computed against the wrong prior
-- week). template_key is retained in the key because multiple templates per distributor-week are
-- legitimate (that is exactly why the existing index also keys on it).
--
-- This partial unique index makes the batch INSERT the atomic arbiter for the logical-week slot, so
-- the losing concurrent INSERT fails with 23505, which persistWeeklyUpload now surfaces as the same
-- friendly "already validated for this week" 409 (see the isPostgresUniqueViolation handling there).
-- Untagged/legacy batches (cycle_month or week_number NULL) and non-validated batches are excluded.
--
-- SAFE: additive index only. No rows are read, modified, or deleted by this migration.
--
-- PRE-APPLY REQUIREMENT (staging first, per AGENTS.md): existing data may already contain more than
-- one validated batch sharing (distributor_code, cycle_month, week_number, template_key). CREATE
-- UNIQUE INDEX will FAIL to build if such collisions exist. Before applying, audit and resolve with:
--
--   select distributor_code, cycle_month, week_number, template_key, count(*)
--   from public.weekly_sales_batches
--   where status = 'validated' and cycle_month is not null and week_number is not null
--   group by distributor_code, cycle_month, week_number, template_key
--   having count(*) > 1;
--
-- Resolve any results by deleting the stale/duplicate batch (weekly batches are re-uploadable) first.

create unique index if not exists weekly_sales_batches_validated_cycle_week_tmpl_uidx
  on public.weekly_sales_batches (distributor_code, cycle_month, week_number, template_key)
  where status = 'validated' and cycle_month is not null and week_number is not null;
