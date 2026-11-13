-- recovery_protects_money_and_people_tables — the hourly undo log covers every money and people table
--
-- WHAT THIS CHANGES:
--   Registers 43 more tables in recovery.protected_tables, so recovery.take_snapshots() (pg_cron,
--   :05 every hour) keeps a restorable copy of each whenever its contents change. Until now it
--   covered 7: salary_records, salary_batches, employees, the two monthly-closing tables, monthly
--   targets and the line-area map. No function changes; the registry is the design's own lever
--   ("add a table by setting a registry row, not by editing a function",
--   docs/security/recovery-snapshots.md).
--
-- WHY (enterprise audit 2026-11-13, finding F-DB-011, recommendation REC-036):
--   Production has no point-in-time recovery. The owner was shown its price on 2026-09-29 and chose
--   this zero-cost undo log instead; it protected payroll's two tables and the roster, but not the
--   tables payroll is computed FROM — the automated-payroll run and its holds, deductions and their
--   decisions, expenses, leave, attendance settlements, resignations, hiring and probation. A bad
--   write to any of those at 14:00 could only be undone from last night's backup, restored into a
--   separate project. This closes REC-036's second option: "the snapshot set is shown to cover
--   every money and people table".
--
-- WHAT IS LEFT OUT, ON PURPOSE (recorded in docs/security/recovery-snapshots.md):
--   * Append-only trails (automated_payroll_audit, deductions_audit, employee_salary_change_log,
--     employee_change_log): UPDATE, DELETE and TRUNCATE are refused by trigger, so there is
--     nothing for a restore to undo.
--   * Tables rebuilt from others (expense_claims, expense_claim_events by phx_refresh_expense_claims;
--     the weekly attendance digests): restore the source and rebuild.
--
-- COST, MEASURED ON PRODUCTION 2026-11-13 (read-only, canonical JSON of the whole table):
--   the 43 together are 14.2 MB per full version; the largest are attendance_raw_punches 3.3 MB,
--   deductions_candidates 3.0 MB, outstation_expense_requests 2.2 MB, v2_vacation_requests 2.0 MB
--   and deductions_decisions 1.0 MB. Those five keep 24 changed versions (a working day of hours)
--   instead of 72, so they cannot drive the store's 512 MB on-disk ceiling and evict the other
--   tables' history; the daily-marker rule still keeps the first version of each day for 30 days.
--   An unchanged hour costs a streamed fingerprint and writes nothing (20261016103901).
--
-- ROLLBACK:
--   update recovery.protected_tables set enabled = false
--   where note like 'REC-036 %';
--   (Disabling keeps the versions already taken; deleting the registry rows is not needed.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive: it adds registry rows and writes no application data.

begin;

insert into recovery.protected_tables (source_schema, source_table, pk_columns, note, max_versions) values
  -- payroll: the automated run, its holds and carry-forwards, and the inputs it reads
  ('public', 'automated_payroll_runs',                  array['id'],                             'REC-036 payroll run headers', 72),
  ('public', 'automated_payroll_draft_rows',            array['run_id','employee_hr_id_compact'],'REC-036 payroll draft, one row per person', 72),
  ('public', 'automated_payroll_step_state',            array['run_id','step_key'],              'REC-036 payroll step confirmations', 72),
  ('public', 'automated_payroll_carry_forward',         array['id'],                             'REC-036 payroll carry-forwards', 72),
  ('public', 'automated_payroll_held_releases',         array['id'],                             'REC-036 held-salary releases', 72),
  ('public', 'automated_payroll_held_part1_unpaid',     array['id'],                             'REC-036 held salary, part one unpaid', 72),
  ('public', 'automated_payroll_held_entered',          array['id'],                             'REC-036 held salary, entered', 72),
  ('public', 'automated_payroll_held_settlements',      array['id'],                             'REC-036 held-salary settlements', 72),
  ('public', 'automated_payroll_non_employees',         array['id'],                             'REC-036 payroll lines for non-employees', 72),
  ('public', 'automated_payroll_non_employee_recurring',array['id'],                             'REC-036 recurring non-employee lines', 72),
  ('public', 'automated_payroll_standing_additions',    array['id'],                             'REC-036 standing additions', 72),
  ('public', 'payroll_recurring_adjustments',           array['id'],                             'REC-036 recurring adjustments', 72),
  ('public', 'payroll_statutory_config',                array['id'],                             'REC-036 statutory payroll settings', 72),
  ('public', 'salary_flags',                            array['id'],                             'REC-036 salary flags', 72),
  ('public', 'salary_allowance_defaults',               array['job_title'],                      'REC-036 allowance defaults by title', 72),
  ('public', 'employee_compensation',                   array['employee_hr_id'],                 'REC-036 compensation per person', 72),
  ('public', 'employee_salary_structure',               array['id'],                             'REC-036 salary structure', 72),
  ('public', 'payroll_copilot_runs',                    array['id'],                             'REC-036 payroll copilot runs', 72),
  ('public', 'payroll_copilot_adjustments',             array['id'],                             'REC-036 payroll copilot adjustments', 72),
  ('public', 'payroll_copilot_flags',                   array['id'],                             'REC-036 payroll copilot flags', 72),
  ('public', 'payroll_copilot_vacation_settlements',    array['id'],                             'REC-036 payroll copilot vacation settlements', 72),
  ('public', 'payroll_copilot_expense_decisions',       array['id'],                             'REC-036 payroll copilot expense decisions', 72),
  -- deductions and disputes
  ('public', 'deductions_candidates',                   array['id'],                             'REC-036 deduction candidates — 3.0 MB a version, so fewer kept', 24),
  ('public', 'deductions_decisions',                    array['id'],                             'REC-036 deduction decisions — 1.0 MB a version, so fewer kept', 24),
  ('public', 'deductions_publications',                 array['id'],                             'REC-036 deduction publications', 72),
  ('public', 'deductions_publication_lines',            array['id'],                             'REC-036 deduction publication lines', 72),
  ('public', 'daily_deductions_publications',           array['id'],                             'REC-036 daily deduction publications', 72),
  ('public', 'daily_deductions_lines',                  array['id'],                             'REC-036 daily deduction lines', 72),
  ('public', 'dispute_refunds',                         array['id'],                             'REC-036 dispute refunds', 72),
  -- expenses
  ('public', 'outstation_expense_requests',             array['id'],                             'REC-036 outstation expense requests — 2.2 MB a version, so fewer kept', 24),
  ('public', 'outstation_expenses',                     array['id'],                             'REC-036 outstation expense lines', 72),
  ('public', 'outstation_expense_reports',              array['id'],                             'REC-036 outstation expense reports', 72),
  ('public', 'expense_payroll_links',                   array['id'],                             'REC-036 expense-to-payroll links', 72),
  -- leave and attendance
  ('public', 'v2_vacation_requests',                    array['id'],                             'REC-036 leave requests — 2.0 MB a version, so fewer kept', 24),
  ('public', 'v2_vacation_approval_steps',              array['id'],                             'REC-036 leave approval steps', 72),
  ('public', 'attendance_settlements',                  array['id'],                             'REC-036 attendance settlements', 72),
  ('public', 'attendance_annual_balance_charges',       array['id'],                             'REC-036 annual-balance charges', 72),
  ('public', 'attendance_raw_punches',                  array['id'],                             'REC-036 fingerprint punches — 3.3 MB a version, so fewer kept', 24),
  -- people
  ('public', 'employee_resignations',                   array['id'],                             'REC-036 resignations', 72),
  ('public', 'employee_hiring_profile',                 array['hr_id'],                          'REC-036 hiring profile per person', 72),
  ('public', 'employee_offboarding_profile',            array['hr_id'],                          'REC-036 offboarding profile per person', 72),
  ('public', 'probation_cases',                         array['id'],                             'REC-036 probation cases', 72),
  ('public', 'probation_evaluations',                   array['id'],                             'REC-036 probation evaluations', 72)
on conflict (source_schema, source_table) do nothing;

-- Refuse to finish if a registered key is not the table's real primary key: the store orders and
-- restores by it, and a wrong one would restore a table it cannot match row for row.
do $$
declare
  r record;
  v_pk text[];
begin
  for r in select * from recovery.protected_tables where note like 'REC-036 %' loop
    select array_agg(a.attname::text order by array_position(i.indkey::int[], a.attnum::int))
      into v_pk
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = format('%I.%I', r.source_schema, r.source_table)::regclass
       and i.indisprimary;
    if v_pk is distinct from r.pk_columns then
      raise exception '%.% is registered with key % but its primary key is %',
        r.source_schema, r.source_table, r.pk_columns, v_pk;
    end if;
  end loop;
end $$;

commit;

-- Timestamp 20261113151741 was minted to sort after every migration already on main.
