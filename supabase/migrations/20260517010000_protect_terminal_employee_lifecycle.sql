create or replace function public.phx_prevent_terminal_employee_reactivation()
returns trigger
language plpgsql
as $$
declare
  old_status text := lower(trim(coalesce(old.employment_status, '')));
  new_status text := lower(trim(coalesce(new.employment_status, old.employment_status, '')));
  allow_override text := coalesce(current_setting('request.phx_allow_terminal_employee_reactivation', true), '');
begin
  if allow_override = 'on' then
    return new;
  end if;

  if old_status in ('resigned', 'terminated') then
    if new_status not in ('resigned', 'terminated') then
      raise exception 'Terminal employees cannot be reactivated outside a governed workflow.'
        using errcode = 'P0001';
    end if;

    if coalesce(new.organogram_visible, false) = true or coalesce(new.payroll_eligible, false) = true then
      raise exception 'Terminal employees cannot be restored to organogram/payroll visibility outside a governed workflow.'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists phx_prevent_terminal_employee_reactivation on public.employees;

create trigger phx_prevent_terminal_employee_reactivation
before update on public.employees
for each row
execute function public.phx_prevent_terminal_employee_reactivation();

revoke all on function public.phx_prevent_terminal_employee_reactivation() from public;
grant all on function public.phx_prevent_terminal_employee_reactivation() to service_role;
