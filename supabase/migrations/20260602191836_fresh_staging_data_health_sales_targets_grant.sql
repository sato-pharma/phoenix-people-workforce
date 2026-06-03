-- Fresh staging data-health orphan audit dependency.
-- v_hr_id_orphan_audit is a security-invoker governance view and needs the
-- calling service role to read sales_targets as one of its underlying sources.

begin;

grant select on table public.sales_targets to service_role;

notify pgrst, 'reload schema';

commit;
