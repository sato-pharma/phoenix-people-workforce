-- Fresh staging data-health compatibility.
-- The server-rendered data health page reads aggregate/governance sources through
-- the service-role Data API. Keep these grants server-only; do not expose to
-- anon/authenticated roles.

begin;

grant select on table public.sales_records to service_role;
grant select on table public.areas to service_role;
grant select on table public.lines to service_role;
grant select on table public.v_hr_id_orphan_audit to service_role;

notify pgrst, 'reload schema';

commit;
