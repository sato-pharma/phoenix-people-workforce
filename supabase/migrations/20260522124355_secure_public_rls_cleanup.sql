-- Tighten public tables that should only be accessed through server-side
-- service-role code. These tables are in the exposed public schema, so RLS
-- must be enabled before leaving any role-level grants in place.

do $$
declare
  table_row record;
begin
  for table_row in
    select *
    from (
      values
        ('employee_salary_structure', 'employee_salary_structure_service_role_all'),
        ('leave_notification_attempts', 'leave_notification_attempts_service_role_all'),
        ('leave_request_events', 'leave_request_events_service_role_all'),
        ('salary_allowance_defaults', 'salary_allowance_defaults_service_role_all')
    ) as t(table_name, policy_name)
  loop
    if exists (
      select 1
      from pg_tables
      where schemaname = 'public'
        and tablename = table_row.table_name
    ) then
      execute format(
        'alter table public.%I enable row level security',
        table_row.table_name
      );
      execute format(
        'revoke all on table public.%I from anon, authenticated',
        table_row.table_name
      );
      execute format(
        'grant select, insert, update, delete on table public.%I to service_role',
        table_row.table_name
      );
      execute format(
        'drop policy if exists %I on public.%I',
        table_row.policy_name,
        table_row.table_name
      );
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        table_row.policy_name,
        table_row.table_name
      );
    end if;
  end loop;
end $$;

-- Earlier local work created these empty duplicate excuse tables under a
-- longer name. The application uses public.v2_excuse_* instead.
drop table if exists public.v2_employee_excuse_email_tokens;
drop table if exists public.v2_employee_excuse_requests;

notify pgrst, 'reload schema';
