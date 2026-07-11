-- Phase 16 follow-up: legacy employee_probation.hr_id must not block the
-- current employee_hr_id-based probation workflow.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_probation'
      and column_name = 'hr_id'
  ) then
    alter table public.employee_probation alter column hr_id drop not null;
  end if;
end $$;
notify pgrst, 'reload schema';
