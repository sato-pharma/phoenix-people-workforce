-- Fresh staging offer lifecycle service-role grants.
-- The offer dashboard and workflow routes run server-side through the
-- service-role Data API. Keep these grants server-only; do not grant
-- anon/authenticated access to candidate or compensation data.

begin;

grant select, insert, update, delete on table public.job_offers to service_role;
grant select, insert on table public.job_offer_audit_logs to service_role;
grant select, insert on table public.job_offer_decision_events to service_role;

notify pgrst, 'reload schema';

commit;
