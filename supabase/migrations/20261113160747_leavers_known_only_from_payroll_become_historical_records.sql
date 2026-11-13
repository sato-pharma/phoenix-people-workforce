-- leavers_known_only_from_payroll_become_historical_records — the 13 people whose salary history
-- had lost its employee get a record again, and salary history and resignation candidates are locked
-- to real employees like the other 22 money tables
--
-- WHAT THIS CHANGES:
--   1. Inserts 13 employee records (B-20, B-21, B-29, B-36, B-44, B-70, B-71, B-87, B-89, B-90, B-93,
--      B-121, B-165) as employment_status 'historical_payroll_record', payroll_eligible false,
--      organogram_visible false. Name, Arabic name and job title come from their own most recent
--      salary_records row. Nothing else is filled in: no hire, resignation or last-working date is
--      invented. A person already in employees is skipped (idempotent).
--   2. Adds salary_records_phx_employee_fkey and payroll_resignation_candidates_phx_employee_fkey
--      -> public.employees(hr_id), ON UPDATE CASCADE ON DELETE RESTRICT, NOT VALID then VALIDATE,
--      after the same refusing orphan count as 20261113160008.
--
-- WHY (enterprise audit 2026-11-13, F-DB-001, REC-037 slice 2):
--   13 salary_records rows (Jan and Mar 2026 batches) and 12 payroll_resignation_candidates rows
--   named people whose employee row no longer exists, so those two tables could not take the key.
--   The owner chose, 2026-11-13 ~16:10 Cairo: restore them, as "Historical payroll record" — the
--   status the 15 people known only from the Jan–Mar 2026 salary files already carry.
--
-- WHY THIS STATUS AND NOT 'resigned':
--   * a resigned record carries a resignation date and 12 of the 13 have none on record;
--   * phx_employee_terminal_vacancy_guard opens a replacement vacancy for every resigned insert;
--   * hasDepartedEmployment (src/lib/auth/session-lifecycle.ts) never counts this status as a
--     leaver, so turnover reports do not change.
--
-- TRIGGERS ON THE INSERT, checked 2026-11-13:
--   * terminal vacancy guard / autofill vacancy: do nothing for this status.
--   * probation provisioning: no hire_date is written, so it returns at once.
--   * phx_employee_insert_reconcile_stale_vacancies re-reconciles EVERY open vacancy on any insert.
--     It is switched off for this one insert only (same transaction), so restoring history never
--     closes a live vacancy as a side effect.
--   * phx_employees_change_log stays on: the restore is recorded in the employee history.
--
-- SIDE EFFECTS:
--   * The 13 appear in the employee directory under "Historical payroll record", like the 15.
--   * Their salary_records rows now resolve to a person in scope-filtered payroll views.
--   * A salary_records or payroll_resignation_candidates row naming an unknown id is refused (23503).
--
-- ROLLBACK (drops the two keys, then the 13 records; the salary rows themselves are never touched):
--   alter table public.salary_records drop constraint salary_records_phx_employee_fkey;
--   alter table public.payroll_resignation_candidates drop constraint payroll_resignation_candidates_phx_employee_fkey;
--   delete from public.employees where employment_status = 'historical_payroll_record'
--     and hr_id in ('B-20','B-21','B-29','B-36','B-44','B-70','B-71','B-87','B-89','B-90','B-93','B-121','B-165');
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- 13 inserted rows; no row is updated or deleted.

begin;

alter table public.employees disable trigger phx_employee_insert_reconcile_stale_vacancies;

insert into public.employees (hr_id, full_name, name_ar, job_title, employment_status,
                              payroll_eligible, organogram_visible)
select distinct on (s.hr_id)
       s.hr_id, s.full_name, s.name_ar, s.job_title, 'historical_payroll_record', false, false
  from public.salary_records s
 where s.hr_id in ('B-20','B-21','B-29','B-36','B-44','B-70','B-71','B-87','B-89','B-90','B-93',
                   'B-121','B-165')
   and nullif(trim(s.full_name), '') is not null
   and not exists (select 1 from public.employees e where e.hr_id = s.hr_id)
 order by s.hr_id, s.created_at desc;

alter table public.employees enable trigger phx_employee_insert_reconcile_stale_vacancies;

do $$
declare
  pairs constant text[][] := array[
    array['salary_records',                 'hr_id'],
    array['payroll_resignation_candidates', 'hr_id']
  ];
  i       int;
  tbl     text;
  col     text;
  cname   text;
  orphans bigint;
begin
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
