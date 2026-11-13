-- money_leave_attendance_rows_name_a_real_employee — the database refuses a pay, deduction, leave or
-- attendance row for an employee who does not exist
--
-- WHAT THIS CHANGES:
--   Adds a foreign key from the employee column of 22 money, leave and attendance tables (one
--   constraint each, `<table>_phx_employee_fkey`, listed below) to public.employees(hr_id), ON UPDATE CASCADE ON DELETE RESTRICT —
--   the clause the older money keys already use (outstation_expense_requests, expense_claims).
--   Each is added NOT VALID and then VALIDATED, in one transaction.
--
-- WHY (enterprise audit 2026-11-13, finding F-DB-001, recommendation REC-037, slice 1):
--   hr_id is a text business key normalised in application code. 566 hr_id columns sit in 331
--   public tables and 81 carried a foreign key; none of the payroll-run, deduction, dispute-refund,
--   leave or attendance-settlement tables did. A mistyped or differently-cased id made a row that
--   belongs to nobody, and every report joining on the key dropped or double-counted it silently.
--   Now the write is refused instead.
--
-- MEASURED ON PRODUCTION 2026-11-13 (read-only), before this was written:
--   every column below holds ZERO values with no matching employee and zero case-only mismatches.
--   The DO block below re-counts and refuses to proceed if that is no longer true.
--
-- LEFT OUT ON PURPOSE (each needs its own decision or repair first):
--   * salary_records.hr_id (13 rows) and payroll_resignation_candidates.hr_id (12 rows) name 13
--     leavers whose employee row no longer exists. Adding the key needs those rows' employees
--     restored or the rows judged — the owner's decision, not this migration's.
--   * Actor columns (actor_hr_id, decided_by_hr_id, created_by_hr_id ...): they also hold
--     'system', 'OPS-RECOLLECT' and older lower-case ids by design. They record who acted, not whose
--     money it is.
--   * outstation_expense_requests.medical_trip_hr_id: 42 values differ from the employee only by
--     case — a repair, then a key, in a later slice.
--
-- SIDE EFFECTS:
--   * An insert or update naming an hr_id that is not in employees now fails (23503). Nothing in
--     the application writes such a row today (zero found); the staging smoke scripts delete their
--     child rows before their test employee.
--   * Deleting an employee who has any of these rows is refused (RESTRICT). The application never
--     deletes an employee.
--   * An hr_id rename cascades into these tables. Three refuse every update by trigger
--     (attendance_annual_balance_charges, attendance_settlements,
--     automated_payroll_draft_cell_history), so renaming a person who has rows there is refused —
--     nothing in the application renames an hr_id.
--
-- ROLLBACK (drops only the constraints this file adds; no row is touched):
--   do $$ declare r record; begin
--     for r in select conrelid::regclass as t, conname from pg_constraint
--              where contype = 'f' and conname like '%\_phx\_employee\_fkey' loop
--       execute format('alter table %s drop constraint %I', r.t, r.conname);
--     end loop; end $$;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: it adds constraints and writes no row.

begin;

do $$
declare
  pairs constant text[][] := array[
    -- attendance
    array['attendance_annual_balance_charges',     'employee_hr_id'],
    array['attendance_exceptions',                 'employee_hr_id'],
    array['attendance_settlements',                'employee_hr_id'],
    array['attendance_weekly_digests',             'employee_hr_id'],
    -- the automated payroll run
    array['automated_payroll_carry_forward',       'employee_hr_id'],
    array['automated_payroll_draft_cell_history',  'employee_hr_id'],
    array['automated_payroll_draft_rows',          'employee_hr_id'],
    array['automated_payroll_held_entered',        'employee_hr_id'],
    array['automated_payroll_held_part1_unpaid',   'employee_hr_id'],
    array['automated_payroll_held_releases',       'employee_hr_id'],
    array['automated_payroll_held_settlements',    'employee_hr_id'],
    array['automated_payroll_standing_additions',  'employee_hr_id'],
    array['payroll_copilot_adjustments',           'employee_hr_id'],
    array['payroll_copilot_expense_decisions',     'employee_hr_id'],
    array['payroll_copilot_flags',                 'employee_hr_id'],
    array['payroll_copilot_vacation_settlements',  'employee_hr_id'],
    array['payroll_recurring_adjustments',         'employee_hr_id'],
    -- deductions and disputes
    array['daily_deductions_lines',                'employee_hr_id'],
    array['deductions_candidates',                 'employee_hr_id'],
    array['deductions_publication_lines',          'employee_hr_id'],
    array['dispute_refunds',                       'employee_hr_id'],
    -- leave
    array['v2_vacation_requests',                  'employee_hr_id']
  ];
  i         int;
  tbl       text;
  col       text;
  cname     text;
  orphans   bigint;
begin
  -- 1. Refuse to start if any column now holds an id with no employee.
  for i in 1 .. array_length(pairs, 1) loop
    tbl := pairs[i][1];
    col := pairs[i][2];
    execute format(
      'select count(*) from public.%I t where t.%I is not null
         and not exists (select 1 from public.employees e where e.hr_id = t.%I)',
      tbl, col, col)
      into orphans;
    if orphans > 0 then
      raise exception 'public.%.% holds % row(s) naming no employee — repair them before this key',
        tbl, col, orphans;
    end if;
  end loop;

  -- 2. Add each key NOT VALID, then validate it. Idempotent: a key already present is skipped.
  for i in 1 .. array_length(pairs, 1) loop
    tbl := pairs[i][1];
    col := pairs[i][2];
    cname := tbl || '_phx_employee_fkey';
    if exists (select 1 from pg_constraint
                where conrelid = format('public.%I', tbl)::regclass and conname = cname) then
      continue;
    end if;
    execute format(
      'alter table public.%I add constraint %I foreign key (%I)
         references public.employees (hr_id) on update cascade on delete restrict not valid',
      tbl, cname, col);
    execute format('alter table public.%I validate constraint %I', tbl, cname);
  end loop;
end $$;

commit;

-- Timestamp 20261113160008 was minted to sort after every migration already on main.
