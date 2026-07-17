-- Remove the outstation expense variance columns.
--
-- Variance (claimed - expected, and its percentage) has been removed from the
-- product entirely (owner decision): it is no longer computed, stored, displayed,
-- or used in the approval recommendation. These columns are now dead — nothing in
-- application code reads or writes them after this change. The claimed and
-- expected totals are retained.
--
-- Safe to drop: no foreign key, index, view, RLS policy, or generated column
-- references variance_amount / variance_percent.

ALTER TABLE public.outstation_expense_requests
  DROP COLUMN IF EXISTS variance_amount,
  DROP COLUMN IF EXISTS variance_percent;
