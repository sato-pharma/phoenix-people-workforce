-- Replace the implicit `EXECUTE TO PUBLIC` default on the last two `private` SECURITY DEFINER RLS
-- helpers with the explicit grant pattern the rest of this database already uses.
--
-- WHAT WAS FOUND (production, read from pg_catalog on 2026-10-08)
--
-- `private.phx_resigned_hr_ids()` and `private.phx_visible_hr_ids()` are SECURITY DEFINER and have
-- `pg_proc.proacl IS NULL` — meaning no ACL was ever set, so they still carry PostgreSQL's built-in
-- default of `EXECUTE TO PUBLIC`. Every login role is a member of PUBLIC, and `authenticated` DOES
-- hold USAGE on the `private` schema (`nspacl` = `authenticated=U/postgres`), so the grant is live
-- rather than theoretical. They are the only two of the 31 reachable SECURITY DEFINER functions
-- still relying on that default.
--
-- This is precisely the leak class `tests/migrations-secdef-revoke-guard.test.ts` exists to prevent,
-- described in `20260719170000_phx_harden_public_function_default_execute.sql`: a function inherits
-- `EXECUTE TO PUBLIC`, and PUBLIC is the operative grantee, so an explicit grant is the only thing
-- that bounds who can call it. That hardening flipped the DEFAULT PRIVILEGES for the `public`
-- schema; these two live in `private` and kept the built-in default.
--
-- WHY THE FUNCTIONS THEMSELVES ARE NOT TOUCHED, AND EXECUTE IS NOT REMOVED
--
-- Both are load-bearing RLS helpers: each is named by **13 policies** on production. A policy
-- expression is evaluated as the QUERYING role, so `authenticated` must keep EXECUTE or every
-- affected read breaks for logged-in browser users. This migration therefore does not reduce
-- anyone's effective access — it only states it explicitly:
--
--   before   PUBLIC has EXECUTE (so: authenticated via PUBLIC; anon blocked only by schema USAGE)
--   after    authenticated and service_role have EXECUTE; PUBLIC has none
--
-- Net effect, role by role: `authenticated` unchanged (explicit instead of inherited),
-- `service_role` unchanged (stated rather than assumed), `postgres`/owner unchanged (implicit),
-- `anon` unchanged (it has no USAGE on `private`, so it could not reach them before either).
--
-- WHAT THIS REMOVES IS THE LATENT RISK, NOT A CURRENT PRIVILEGE
--
-- While the grant is PUBLIC, the only thing keeping `anon` out is the `private` schema's USAGE
-- grant. Anyone granting `anon` USAGE on `private` later — for one unrelated helper, say — would
-- silently make both of these anon-callable, and they return sets of HR ids. After this migration
-- that same change grants nothing, because the functions name their callers.
--
-- NOT IN THIS MIGRATION, DELIBERATELY
--
-- The 14 `public` SECURITY DEFINER functions the Supabase linter reports as
-- `authenticated_security_definer_function_executable` are left exactly as they are. They are an
-- accepted-by-design finding, and 10 of the 14 are provably load-bearing: 5 are named by RLS
-- policies (`current_access_can_manage_employees` alone appears in 81 policies across 23 tables)
-- and 8 are called as RPCs through a real authenticated client by
-- `scripts/phase24-real-auth-rls-api-smoke.ts` and `tests/scripts/phoenix-staging-rls-harness.ts`,
-- which is how the DB-layer role mapping is asserted. Their PUBLIC grant was already revoked in the
-- schema baseline, so the leak class above does not apply to them.
--
-- `au.f_monthly_achievement_live` also has a NULL ACL, and is deliberately left alone: the `au`
-- schema grants USAGE to neither `anon` nor `authenticated`, so no browser role can reach it, and
-- it is on the monthly-achievement read path.
--
-- SAFETY
--
-- Idempotent and non-destructive: no data is read or written, no function body changes, and the
-- statements are safe to replay. Reversal is `grant execute ... to public` on both.

begin;

-- phx_visible_hr_ids: the set of HR ids the current user may see. 13 policies call it.
revoke execute on function private.phx_visible_hr_ids() from public;
grant  execute on function private.phx_visible_hr_ids() to authenticated, service_role;

-- phx_resigned_hr_ids: the resigned-employee carve-out those same policies apply. 13 policies.
revoke execute on function private.phx_resigned_hr_ids() from public;
grant  execute on function private.phx_resigned_hr_ids() to authenticated, service_role;

-- Fail loudly if the result is not what this migration claims, rather than leaving a silent
-- half-state: PUBLIC must be gone and `authenticated` must still hold EXECUTE, or the RLS policies
-- that call these would start refusing logged-in readers.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['phx_visible_hr_ids', 'phx_resigned_hr_ids'] loop
    if (select proacl is null from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private' and p.proname = v_fn) then
      raise exception 'private.%: ACL is still NULL, so the PUBLIC default was not replaced', v_fn;
    end if;
    if not has_function_privilege('authenticated', 'private.' || v_fn || '()', 'EXECUTE') then
      raise exception 'private.%: authenticated lost EXECUTE — 13 RLS policies call this', v_fn;
    end if;
    if has_function_privilege('anon', 'private.' || v_fn || '()', 'EXECUTE') then
      raise exception 'private.%: anon holds EXECUTE, which this migration must not grant', v_fn;
    end if;
  end loop;
end $$;

commit;
