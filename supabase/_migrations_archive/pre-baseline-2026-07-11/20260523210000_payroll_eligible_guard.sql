-- Payroll eligibility guard.
--
-- The payroll_eligible flag on employees can become stale if the employee's
-- status changes between import cycles. This migration adds:
--   1. A BEFORE INSERT trigger on salary_records that raises a WARNING (never
--      an error) when the referenced employee is currently ineligible.
--   2. A view for the data-health dashboard listing all salary records whose
--      employee is currently marked ineligible.

create or replace function public.trg_salary_record_eligibility_fn()
returns trigger language plpgsql security definer as $$
declare
  is_eligible boolean;
begin
  if new.hr_id is not null then
    select payroll_eligible
    into is_eligible
    from public.employees
    where lower(hr_id) = lower(new.hr_id)
    limit 1;

    if found and is_eligible = false then
      raise warning
        'PAYROLL ELIGIBILITY: salary record inserted for hr_id=% whose payroll_eligible flag is false.',
        new.hr_id;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_salary_record_eligibility on public.salary_records;
create trigger trg_salary_record_eligibility
  before insert on public.salary_records
  for each row execute function public.trg_salary_record_eligibility_fn();
-- Data-health view: salary records for currently-ineligible employees.
drop view if exists public.v_ineligible_employee_salary_records;
create or replace view public.v_ineligible_employee_salary_records as
  select
    sr.id,
    sr.hr_id,
    sr.batch_id,
    e.full_name,
    e.payroll_eligible
  from public.salary_records sr
  join public.employees e
    on lower(e.hr_id) = lower(sr.hr_id)
  where e.payroll_eligible = false
    and sr.hr_id is not null;
revoke all on public.v_ineligible_employee_salary_records from anon, authenticated;
grant select on public.v_ineligible_employee_salary_records to service_role;
notify pgrst, 'reload schema';
