-- Workstream 1 — Employee Portal launch RLS closure (surgical, single table).
--
-- public.employee_support_requests is the only portal-owned table with RLS
-- disabled (Supabase advisor ERROR rls_disabled_in_public). The support service
-- accesses it exclusively via the service-role client
-- (src/lib/support-requests/service.ts -> getSupabaseAdmin()), so the correct
-- launch fix is deny-by-default for anon/authenticated plus service_role-only
-- access. This mirrors the established public.job_offers / critical_public_rls
-- closure pattern.
--
-- Phoenix uses application-managed auth (not Supabase Auth), so anon/authenticated
-- requests carry no auth.uid(). Self-scoped (hr_id = current user) policies would
-- not function and are intentionally NOT created. Add authenticated-client policies
-- only if support reads are ever moved off the service-role path with a working
-- identity source (out of launch scope).
--
-- Idempotent (to_regclass guard + drop policy if exists) and reversible
-- (see rollback block at the bottom).
do $$
begin
  if to_regclass('public.employee_support_requests') is not null then
    alter table public.employee_support_requests enable row level security;

    -- Deny-by-default: no anon/authenticated policy is created, and direct
    -- table grants for those roles are revoked.
    revoke all on table public.employee_support_requests from anon, authenticated;

    -- Server-side service-role path keeps full access.
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
-- ----------------------------------------------------------------------------
-- Verification (run read-only AFTER applying on a Supabase branch/preview):
--
--   -- 1) RLS is enabled, policy present:
--   select c.relrowsecurity as rls_enabled,
--          (select count(*) from pg_policies p
--             where p.schemaname='public' and p.tablename='employee_support_requests') as policy_count
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   where n.nspname='public' and c.relname='employee_support_requests';
--   -- expect: rls_enabled = t, policy_count = 1
--
--   -- 2) Foreign-row probe with a non-service-role JWT (anon/authenticated):
--   select * from public.employee_support_requests where hr_id <> '<self>';
--   -- expect: 0 rows (deny-by-default)
--
--   -- 3) Re-run Supabase security advisors:
--   -- expect: ERROR rls_disabled_in_public for employee_support_requests is cleared.
--
-- Rollback (if ever required):
--   drop policy if exists employee_support_requests_service_role_all
--     on public.employee_support_requests;
--   alter table public.employee_support_requests disable row level security;
-- ----------------------------------------------------------------------------;
