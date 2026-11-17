-- salary_flag_review_mark_on_locked_month
--
-- WHAT THIS CHANGES: the payroll lock trigger (phx_prevent_closed_salary_detail_mutation, on
--   salary_flags and salary_records) lets ONE kind of change through on an approved or locked month:
--   a salary flag marked reviewed, where nothing but resolved_at and resolved_by changes. Every other
--   change to a flag, and every change to a salary record, is refused exactly as before.
-- WHY: owner, 17 Nov 2026 ("Allow the reviewed mark"). Every open salary flag (22, January to June
--   2026) sits on an approved or locked month, so the Salary Flags page's "Resolve" could never work.
--   It answered a bare "Failed to resolve salary flag." (app error 17 Nov 2026, 01:54 Cairo: P0001
--   "Payroll batch cannot be changed while status is locked."). The reviewed mark is who looked and
--   when; it moves no salary figure.
-- ROLLBACK: re-create the function without the salary_flags block at the top of its body (the body
--   below it is the one this replaces, unchanged).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive and not bulk: one function body, no rows touched.

begin;

create or replace function public.phx_prevent_closed_salary_detail_mutation()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_batch_id uuid;
  v_batch_status text;
  v_part1_paid_at timestamptz;
begin
  -- The reviewed mark on a salary flag (owner, 17 Nov 2026): allowed on any month, locked or not,
  -- when it is the ONLY change. Compared as the whole row minus those two columns, so a column added
  -- later is guarded without touching this function.
  if tg_table_name = 'salary_flags'
    and tg_op = 'UPDATE'
    and (to_jsonb(new) - 'resolved_at' - 'resolved_by') = (to_jsonb(old) - 'resolved_at' - 'resolved_by') then
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_batch_id := old.batch_id;
  else
    v_batch_id := new.batch_id;
  end if;

  select status, part1_paid_at
  into v_batch_status, v_part1_paid_at
  from public.salary_batches
  where id = v_batch_id;

  if v_batch_status in ('approved', 'locked') then
    raise exception 'Payroll batch cannot be changed while status is %.', v_batch_status using errcode = 'P0001';
  end if;

  if tg_table_name = 'salary_records' and v_part1_paid_at is not null then
    if tg_op <> 'UPDATE' then
      raise exception 'Salary records cannot be inserted or deleted after Part 1 is paid.' using errcode = 'P0001';
    end if;

    if new.batch_id is distinct from old.batch_id
      or new.hr_id is distinct from old.hr_id
      or new.full_name is distinct from old.full_name
      or new.name_ar is distinct from old.name_ar
      or new.job_title is distinct from old.job_title
      or new.line is distinct from old.line
      or new.area is distinct from old.area
      or new.hire_date is distinct from old.hire_date
      or new.base_salary is distinct from old.base_salary
      or new.gross_salary is distinct from old.gross_salary
      or new.net_salary is distinct from old.net_salary
      or new.first_part is distinct from old.first_part
      or new.extra_cost_of_living is distinct from old.extra_cost_of_living
      or new.fuel_allowance is distinct from old.fuel_allowance
      or new.social_insurance is distinct from old.social_insurance
      or new.employment_income_tax is distinct from old.employment_income_tax
      or new.governmental_deductions is distinct from old.governmental_deductions
      or new.payment_mode is distinct from old.payment_mode then
      raise exception 'Part 1 salary fields cannot be changed after Part 1 is paid.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$function$;

commit;
