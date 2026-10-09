-- Take INSERT, UPDATE, DELETE and TRUNCATE away from `authenticated` on public.employees and
-- public.employee_locations, and change nothing else.
--
-- WHAT
--   `authenticated` holds arwd on public.employees and arwdDxtm on public.employee_locations. This
--   revokes the write privileges. SELECT stays, so every read keeps working; the policies stay; RLS
--   stays on; `service_role` and the owner keep everything; `anon` already has nothing.
--
-- WHY
--   Nothing in the application writes either table with a user's token. Every write in src/ and app/
--   goes through the service-role client (employee-directory, hiring-pack, the employee import
--   route, the outstation geocoder). The only code that builds a USER-token client
--   (src/lib/supabase/rls-server.ts) is imported by outstation claims-read, outstation expenses and
--   payroll, and none of those three touches either table. No function that `authenticated` can
--   EXECUTE writes either table either (checked in pg_proc against production, 2026-10-10).
--
--   What the grant DOES allow is a direct call to the database REST endpoint with a user's own
--   session token (the cookie is the user's, and the endpoint address and anon key are public):
--     - employee_locations: policy `employee_locations_{insert,update}_access` lets ANY signed-in
--       user insert or update the row whose employee_hr_id is their own, including
--       residence_latitude / residence_longitude, and the table has no trigger. Outstation expense
--       claims freeze their distance from those coordinates, so this is a self-service edit of an
--       input to money. Probed on production inside a rolled-back transaction as an active Medical
--       Rep: own row UPDATE allowed 1, any other row 0.
--     - employees: the write policies admit only Super Admin / SUPER_ADMIN scope (a non-admin probe
--       updated 0 rows), so this removes a second route for one account, not an open hole.
--   With the grants gone, those direct writes fail with `permission denied` before RLS is consulted.
--
-- WHAT THIS DOES NOT CHANGE
--   - READ access. A District Manager's token still reads salary, national id and bank account of
--     their team's employees rows (5 rows with all three populated in a probe); that is a separate
--     question about the SELECT policy and column grants, deliberately left alone here.
--   - REFERENCES, TRIGGER and MAINTAIN on employee_locations. They are not writes through the REST
--     API (creating a trigger needs DDL it does not expose).
--   - The two security_invoker views over these tables; writes through them already failed on the
--     base-table grant, and 20261009223000 removed their own write grants.
--
-- RE-APPLY / OTHER DATABASES
--   REVOKE of a privilege not held is a no-op, so this is safe twice. A table that does not exist is
--   skipped with a notice. The block ends by re-asking the catalog and RAISES if `authenticated` still
--   holds any write privilege (table-level OR column-level) on a table that exists, if it lost
--   SELECT, if RLS was switched off, or if `service_role` lost a write.
--
-- ROLLBACK
--   grant insert, update, delete on public.employees to authenticated;
--   grant insert, update, delete, truncate on public.employee_locations to authenticated;

do $$
declare
  v_tbl  text;
  v_priv text;
begin
  set local lock_timeout = '5s';

  foreach v_tbl in array array['employees', 'employee_locations'] loop
    if to_regclass('public.' || v_tbl) is null then
      raise notice 'public.% does not exist here - skipped', v_tbl;
      continue;
    end if;

    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', v_tbl);

    -- Re-read, never assume. Table-level first, then column-level (Postgres drops column grants with
    -- the table-level revoke, so the second loop is a belt over the first).
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('authenticated', 'public.' || v_tbl, v_priv) then
        raise exception 'refusing: authenticated still holds % on public.%', v_priv, v_tbl;
      end if;
    end loop;

    foreach v_priv in array array['INSERT', 'UPDATE'] loop
      if has_any_column_privilege('authenticated', 'public.' || v_tbl, v_priv) then
        raise exception 'refusing: authenticated still holds a column-level % on public.%', v_priv, v_tbl;
      end if;
    end loop;

    if not has_table_privilege('authenticated', 'public.' || v_tbl, 'SELECT') then
      raise exception 'refusing: authenticated lost SELECT on public.%', v_tbl;
    end if;

    if has_table_privilege('anon', 'public.' || v_tbl, 'SELECT') then
      raise exception 'refusing: anon holds SELECT on public.%', v_tbl;
    end if;

    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_tbl)::regclass) then
      raise exception 'refusing: row level security is OFF on public.%', v_tbl;
    end if;

    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', 'public.' || v_tbl, v_priv) then
        raise exception 'refusing: service_role lost % on public.%', v_priv, v_tbl;
      end if;
    end loop;

    raise notice 'revoked INSERT/UPDATE/DELETE/TRUNCATE from authenticated on public.%', v_tbl;
  end loop;
end
$$;
