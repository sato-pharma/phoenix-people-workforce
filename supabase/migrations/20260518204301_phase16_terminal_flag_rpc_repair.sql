-- Phase 16 follow-up: service-callable terminal lifecycle flag normalization.

create or replace function public.phx_normalize_terminal_employee_lifecycle_flags(
  p_employee_hr_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
begin
  if nullif(trim(coalesce(p_employee_hr_id, '')), '') is null then
    raise exception 'Employee HR ID is required.' using errcode = '22023';
  end if;

  update public.employees
  set
    payroll_eligible = false,
    organogram_visible = false,
    updated_at = now()
  where upper(hr_id) = upper(trim(p_employee_hr_id))
    and lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  returning *
  into v_employee;

  if not found then
    select *
    into v_employee
    from public.employees
    where upper(hr_id) = upper(trim(p_employee_hr_id));

    if not found then
      return jsonb_build_object('updated', false, 'reason', 'employee_not_found');
    end if;

    return jsonb_build_object(
      'updated', false,
      'reason', 'employee_not_terminal',
      'employee_status', v_employee.employment_status
    );
  end if;

  return jsonb_build_object(
    'updated', true,
    'employee_hr_id', v_employee.hr_id,
    'employee_status', v_employee.employment_status,
    'organogram_visible', v_employee.organogram_visible,
    'payroll_eligible', v_employee.payroll_eligible
  );
end;
$$;
revoke execute on function public.phx_normalize_terminal_employee_lifecycle_flags(text)
from public, anon, authenticated;
grant execute on function public.phx_normalize_terminal_employee_lifecycle_flags(text)
to service_role;
notify pgrst, 'reload schema';
