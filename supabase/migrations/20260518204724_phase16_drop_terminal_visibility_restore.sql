-- Phase 16 follow-up: remove legacy trigger that restores terminal employees
-- to raw organogram/payroll visibility. Effective views already exclude terminal
-- employees, and raw flags must now match the lifecycle state.

drop trigger if exists phx_restore_terminal_employee_visibility on public.employees;
drop function if exists public.phx_restore_terminal_employee_visibility();
update public.employees
set
  payroll_eligible = false,
  organogram_visible = false,
  updated_at = now()
where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  and (
    payroll_eligible is distinct from false
    or organogram_visible is distinct from false
  );
notify pgrst, 'reload schema';
