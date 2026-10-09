-- Take INSERT, UPDATE, DELETE and TRUNCATE away from `authenticated` on the two `public` views that
-- Postgres treats as auto-updatable, and change nothing else.
--
-- WHAT
--   public.v_employee_locations_masked
--   public.v_payroll_eligible_employees
--   `authenticated` holds the full privilege set (arwdDxtm) on both. This revokes the four WRITE
--   privileges. SELECT stays, so every read keeps working; `service_role` and the owner keep
--   everything; `anon` already has nothing.
--
-- WHY
--   Both views are simple enough that Postgres reports them updatable and insertable
--   (information_schema.views: is_updatable = YES, is_insertable_into = YES). They are READ
--   surfaces. The repo's own intent for the masked view is stated in 20260511_rls_gap_closure.sql:
--       grant select on public.v_employee_locations_masked to authenticated, service_role;
--   so the all-privileges ACL on production is drift from that, not a decision. Nothing in src/,
--   tests/ or scripts/ writes through either view: the one src caller of v_payroll_eligible_employees
--   is a service-role head count, the others are .select(); v_employee_locations_masked has no
--   caller in src at all.
--
-- WHAT THIS DOES AND DOES NOT CLOSE (read this before calling it a security fix)
--   Both views are security_invoker = true, so a write through a view is checked against the BASE
--   table's own grants and RLS as the caller. `authenticated` already holds direct write grants
--   on public.employee_locations and public.employees, so this removes a SECOND, redundant way to
--   reach writes that RLS already governs. It is least-privilege hygiene: it adds no protection
--   the base tables' RLS did not already give, and it does NOT touch the base tables' grants, which
--   are a larger and separate question. The other nine `v_*` views are not updatable (a join,
--   aggregate or window in the definition), so their all-privileges ACLs are inert and are left
--   alone here.
--
-- WHAT IS DELIBERATELY LEFT
--   REFERENCES, TRIGGER and MAINTAIN stay on `authenticated` (the ACL goes arwdDxtm -> rxtm). They
--   are not writes: a view cannot be the target of a foreign key, creating a trigger needs DDL that
--   PostgREST does not expose, and MAINTAIN (PostgreSQL 17) governs VACUUM/ANALYZE-type commands
--   that do nothing for a view. Say so rather than widen a change asked for as "the write grants".
--
-- RE-APPLY / OTHER DATABASES
--   REVOKE of a privilege that is not held is a no-op, so this is safe to run twice. A database
--   without a view (to_regclass is null) is skipped with a notice and never fails. The block ends
--   by re-asking the catalog and RAISES if any of the four privileges is still held by
--   `authenticated`, if `authenticated` lost SELECT, or if `service_role` lost anything.
--
-- ROLLBACK (one statement per view)
--   grant insert, update, delete, truncate on public.v_employee_locations_masked to authenticated;
--   grant insert, update, delete, truncate on public.v_payroll_eligible_employees to authenticated;

do $$
declare
  v_view  text;
  v_priv  text;
begin
  set local lock_timeout = '5s';

  foreach v_view in array array['v_employee_locations_masked', 'v_payroll_eligible_employees'] loop
    if to_regclass('public.' || v_view) is null then
      raise notice 'public.% does not exist here - skipped', v_view;
      continue;
    end if;

    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', v_view);

    -- Re-read, never assume: the four writes are gone, SELECT survived, service_role is intact.
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('authenticated', 'public.' || v_view, v_priv) then
        raise exception 'refusing: authenticated still holds % on public.%', v_priv, v_view;
      end if;
    end loop;

    if not has_table_privilege('authenticated', 'public.' || v_view, 'SELECT') then
      raise exception 'refusing: authenticated lost SELECT on public.%', v_view;
    end if;

    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if not has_table_privilege('service_role', 'public.' || v_view, v_priv) then
        raise exception 'refusing: service_role lost % on public.%', v_priv, v_view;
      end if;
    end loop;

    raise notice 'revoked INSERT/UPDATE/DELETE/TRUNCATE from authenticated on public.%', v_view;
  end loop;
end
$$;
