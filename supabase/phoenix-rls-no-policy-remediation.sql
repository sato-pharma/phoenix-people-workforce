-- Phoenix Workforce RLS no-policy remediation.
-- These tables already have RLS enabled. Add explicit service-role-only policies
-- so they are fail-closed and no longer show as policy-less in the linter.

do $$
declare
  t text;
  policy_name text;
  tables_to_lock text[] := array[
    'employee_resignations',
    'notification_events',
    'notification_outbox',
    'position_vacancies',
    'role_permission_overrides',
    'sales_role_overrides',
    'sales_target_batches'
  ];
begin
  foreach t in array tables_to_lock
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I force row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);

      policy_name := 'phx_' || t || '_service_role';
      execute format('drop policy if exists %I on public.%I', policy_name, t);
      execute format(
        'create policy %I on public.%I for all to public using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
        policy_name,
        t
      );
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
