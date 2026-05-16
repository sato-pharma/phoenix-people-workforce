-- Revert the May 14-15 lifecycle visibility hardening that forced
-- resigned/terminated/inactive employees out of directory and payroll views.
--
-- Keep lifecycle status history intact, but restore the employee visibility
-- flags so application filters do not silently hide these rows.

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

  if old_status in ('resigned', 'terminated') and new_status not in ('resigned', 'terminated') then
    raise exception 'Terminal employees cannot be reactivated outside a governed workflow.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function public.phx_restore_terminal_employee_visibility()
returns trigger
language plpgsql
as $$
begin
  if lower(coalesce(new.employment_status, 'active')) in ('resigned', 'terminated', 'inactive') then
    new.payroll_eligible := true;
    new.organogram_visible := true;
  else
    if new.payroll_eligible is null then
      new.payroll_eligible := true;
    end if;

    if new.organogram_visible is null then
      new.organogram_visible := true;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists phx_restore_terminal_employee_visibility on public.employees;

create trigger phx_restore_terminal_employee_visibility
before insert or update of employment_status, payroll_eligible, organogram_visible on public.employees
for each row
execute function public.phx_restore_terminal_employee_visibility();

update public.employees
set
  payroll_eligible = true,
  organogram_visible = true,
  updated_at = now()
where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  and (
    payroll_eligible is distinct from true
    or organogram_visible is distinct from true
  );

revoke all on function public.phx_restore_terminal_employee_visibility() from public;
grant all on function public.phx_restore_terminal_employee_visibility() to service_role;
