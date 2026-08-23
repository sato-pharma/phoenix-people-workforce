-- One salary record per employee per batch -- ENFORCED, not merely observed.
--
-- WHY. `phx_import_approved_expenses_to_payroll` joins salary records to the approved outstation
-- totals on `lower(sr.hr_id) = at.normalized_hr_id`. If two rows in the same batch share an hr_id,
-- both satisfy that join and BOTH are incremented by the full approved expense: the employee is
-- paid their outstation claim twice, and the batch total quietly stops agreeing with the claims it
-- was built from. The 2026-08-24 additive rewrite made the import safe to re-run; it did not, and
-- could not, make the join safe against a duplicated employee.
--
-- Production is clean today. Verified 2026-08-24 against `ozucdzovmcqvepbozvqf`: 796 salary
-- records, 0 collisions on (batch_id, lower(hr_id)), 0 collisions on the raw (batch_id, hr_id),
-- 0 hr_id values anywhere that differ only by case, 0 rows with a null or blank hr_id, 0 rows with
-- a null batch_id. Nothing in the schema was keeping it that way -- `salary_records` carried eight
-- indexes and not one of them was unique apart from the primary key. This index is what turns a
-- property that happens to hold into one that cannot be violated.
--
-- lower(hr_id), NOT hr_id. The import joins case-insensitively, so a unique index on the raw column
-- would still let 'PH-014' and 'ph-014' sit in one batch and collide inside the function -- exactly
-- the double-credit this exists to prevent. Mixed-case hr_id is not hypothetical in this database:
-- `activity_events.hr_id` holds both cases, and the direct-order tables carry hr_id columns in both
-- cases too.
--
-- WHAT THIS CHANGES FOR THE UPLOAD. Both writers -- `phx_create_salary_batch` and
-- `phx_replace_salary_batch` -- insert without an ON CONFLICT clause, so a sheet that lists one
-- employee twice previously produced two salary rows, two payslips, and a double outstation credit,
-- all silently. It now fails the upload with SQLSTATE 23505 instead.
-- `src/lib/payroll/service.ts` maps that to a `PayrollConflictError` (HTTP 409) naming the
-- duplicated employee, so the person uploading is told which row to fix rather than seeing a 500.
-- Failing the upload is the intended outcome: a sheet with one employee on two lines is a sheet
-- that cannot be paid correctly, and finding that out at upload time is the cheap moment.
--
-- PARTIAL, on purpose. Rows with no hr_id are excluded rather than collapsed into a single NULL
-- group. There are none today; the predicate keeps a future blank from failing an upload for a
-- reason that has nothing to do with duplication.
--
-- Creating the index takes a brief ACCESS EXCLUSIVE lock. At 796 rows that is sub-millisecond, so
-- this is not built CONCURRENTLY -- doing so would forfeit running inside the migration transaction
-- for no practical gain at this size.

create unique index if not exists salary_records_batch_hr_unique
  on public.salary_records (batch_id, lower(hr_id))
  where hr_id is not null and btrim(hr_id) <> '';

comment on index public.salary_records_batch_hr_unique is
  'One salary record per employee per batch. Keyed on lower(hr_id) because phx_import_approved_expenses_to_payroll joins case-insensitively; a duplicate would be credited its outstation expense twice.';
