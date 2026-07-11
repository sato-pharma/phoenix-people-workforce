-- Close critical public-table exposure found during staging Supabase audit.
-- The application uses server-side service-role access for these domains, so
-- direct anon/authenticated table access should remain closed.
do $$
begin
  if to_regclass('public.position_vacancies') is not null then
    alter table public.position_vacancies enable row level security;
    revoke all on table public.position_vacancies from anon, authenticated;
    grant select, insert, update, delete on table public.position_vacancies to service_role;

    drop policy if exists position_vacancies_service_role_all on public.position_vacancies;
    create policy position_vacancies_service_role_all
      on public.position_vacancies
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if to_regclass('public.probation_evaluations') is not null then
    alter table public.probation_evaluations enable row level security;
    revoke all on table public.probation_evaluations from anon, authenticated;
    grant select, insert, update, delete on table public.probation_evaluations to service_role;

    drop policy if exists probation_evaluations_service_role_all on public.probation_evaluations;
    create policy probation_evaluations_service_role_all
      on public.probation_evaluations
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if to_regclass('public.role_permission_overrides') is not null then
    alter table public.role_permission_overrides enable row level security;
    revoke all on table public.role_permission_overrides from anon, authenticated;
    grant select, insert, update, delete on table public.role_permission_overrides to service_role;

    drop policy if exists role_permission_overrides_service_role_all on public.role_permission_overrides;
    create policy role_permission_overrides_service_role_all
      on public.role_permission_overrides
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if to_regclass('public.v2_vacation_request_events') is not null then
    alter table public.v2_vacation_request_events enable row level security;
    revoke all on table public.v2_vacation_request_events from anon, authenticated;
    grant select, insert, update, delete on table public.v2_vacation_request_events to service_role;

    if to_regclass('public.v2_vacation_request_events_id_seq') is not null then
      grant usage, select on sequence public.v2_vacation_request_events_id_seq to service_role;
    end if;

    drop policy if exists v2_vacation_request_events_service_role_all on public.v2_vacation_request_events;
    create policy v2_vacation_request_events_service_role_all
      on public.v2_vacation_request_events
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;
