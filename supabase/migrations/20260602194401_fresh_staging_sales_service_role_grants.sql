-- Fresh staging Sales module service-role grants.
-- Sales queue/dashboard routes run server-side through the service-role Data API.
-- Keep these grants server-only; do not expose sales import data to browser roles.

begin;

grant select, insert, update, delete on table public.sales_import_batches to service_role;
grant select, insert, update, delete on table public.sales_records to service_role;
grant select, insert on table public.sales_audit_logs to service_role;

notify pgrst, 'reload schema';

commit;
