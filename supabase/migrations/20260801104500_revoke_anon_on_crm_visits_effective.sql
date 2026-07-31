-- Revoke anon/authenticated access to the CRM effective-visits view.
--
-- WHY
-- `public.ireports360_visits_effective` is granted to `anon` AND `authenticated` (inherited from
-- the baseline's schema-wide `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
-- authenticated`). NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the browser bundle, so
-- `GET /rest/v1/ireports360_visits_effective` is reachable by anyone on the internet.
--
-- It is NOT currently exploitable: the view carries `security_invoker=true`, so it executes as the
-- caller, and neither `anon` nor `authenticated` has SELECT on the underlying `ireports360_visits`
-- / `ireports360_checkins` base tables (both RLS-enabled with a service_role-only policy). A
-- PostgREST call as `anon` errors rather than returning rows.
--
-- But the ONLY thing standing between that public endpoint and the full ~111k-row visit mirror
-- (agent HR ids and names, customer/contact names, free-text comments, and the full raw_payload)
-- is one reloption on a view this repo has already shipped once WITHOUT it — see the note in
-- 20260719240000_apply_backlogged_ireports360_fixes.sql, which records that the original
-- definition did not set security_invoker. Any future `create or replace view` that forgets it
-- re-opens the hole silently, with no failing test.
--
-- Defence in depth: the grant is not needed at all. Every CRM read in the app goes through the
-- service-role client (`getSupabaseAdmin`); there is no `getSupabaseUserClient` usage anywhere in
-- `src/lib/crm/**`, so no application path loses access.
--
-- Deliberately NARROW: this revokes the CRM view only. The schema-wide default-ACL change is a
-- much larger blast radius (13 public views are anon-granted today) and belongs in its own
-- security review, not in a CRM-scoped change.

revoke all on public.ireports360_visits_effective from anon;
revoke all on public.ireports360_visits_effective from authenticated;

-- Keep the roles the app actually uses.
grant select on public.ireports360_visits_effective to service_role;
