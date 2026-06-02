-- Fresh staging Data Health employee-directory lookup grants.
-- Data Health is server-rendered and loads the employee directory through the
-- service-role Data API. Keep these read grants server-only.

begin;

grant select on table public.departments to service_role;
grant select on table public.positions to service_role;
grant select on table public.teams to service_role;
grant select on table public.employee_compensation to service_role;
grant select on table public.employee_locations to service_role;

notify pgrst, 'reload schema';

commit;
