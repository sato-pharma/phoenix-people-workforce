-- P1-05: scope payroll_expenses rows to their salary_batch so the same
-- trip_id can appear in different payroll periods without a unique violation.
--
-- Strategy:
--   • Add batch_id FK (nullable for backward compat with legacy rows)
--   • Add UNIQUE NULLS NOT DISTINCT (batch_id, trip_id) so that:
--       – (null, trip_id) still de-dupes by trip_id alone (legacy / backfill)
--       – (batch-uuid-A, trip_id) and (batch-uuid-B, trip_id) are allowed
--   • The application upsert changes onConflict from "trip_id" to
--     "batch_id,trip_id" which resolves against this constraint.

alter table public.payroll_expenses
  add column if not exists batch_id uuid
    references public.salary_batches(id) on delete set null;
-- NULLS NOT DISTINCT: two (null, "T001") rows still conflict, matching the
-- old trip_id unique behaviour for legacy rows that have no batch_id.
alter table public.payroll_expenses
  add constraint payroll_expenses_batch_trip_unique
  unique nulls not distinct (batch_id, trip_id);
create index if not exists payroll_expenses_batch_id_idx
  on public.payroll_expenses (batch_id);
