-- Fresh staging resignation workflow service-role grants.
-- The resignations dashboard and workflow routes run server-side through the
-- service-role Data API. Keep these grants server-only; do not expose employee
-- lifecycle data to anon/authenticated roles.

begin;

grant select, insert, update, delete on table public.employee_resignations to service_role;
grant select, insert, update, delete on table public.payroll_resignation_candidates to service_role;

notify pgrst, 'reload schema';

commit;
