-- Staging migration-history reconciliation.
-- This is the same idempotent employee_support_requests RLS migration that
-- exists locally as 20260528093000_employee_support_requests_rls.sql, but
-- staging recorded it under version 20260531051719.

do $$
begin
  if to_regclass('public.employee_support_requests') is not null then
    alter table public.employee_support_requests enable row level security;

    revoke all on table public.employee_support_requests from anon, authenticated;

    grant select, insert, update, delete on table public.employee_support_requests to service_role;

    drop policy if exists employee_support_requests_service_role_all
      on public.employee_support_requests;

    create policy employee_support_requests_service_role_all
      on public.employee_support_requests
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;
