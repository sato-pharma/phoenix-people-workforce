-- Say in the schema history what the Rep Entry Days cache's grants already are: the service role
-- only, never a browser role.
--
-- WHAT
--   20261023091035_phoenix_crm_rep_entry_days_cache.sql created public.phoenix_crm_rep_entry_days_cache,
--   switched row security on and granted the service role — but never revoked the browser roles.
--   Its shut state rests entirely on the postgres default privileges in `public` (which today hand
--   new tables to postgres and service_role only). This revokes public, anon and authenticated
--   explicitly and asserts it, so a later change to those defaults, or a re-create of the table under
--   another role, cannot leave the cache readable with the public key.
--
-- WHY (audit 2026-10-26, point 9)
--   The cache holds every rep's entry days by HR id. Measured on production and staging on
--   2026-10-26: ACL {postgres, service_role}, row security on, no policy — so this revoke changes
--   nothing TODAY. It is the explicit statement the creating migration should have carried.
--
-- WHAT THIS DOES NOT CHANGE
--   service_role keeps select, insert, update and delete (asserted below); the rebuild, touch and
--   visit-trigger functions run as their SECURITY DEFINER owner and are untouched. Row security stays
--   on with no policy, so the advisor count is unchanged.
--
-- RE-APPLY / OTHER DATABASES
--   A revoke of a privilege not held is a no-op, so this is safe twice. A database without the table
--   skips it with a notice. RAISES if a browser role still holds any privilege, if row security is
--   off, or if service_role lost one.
--
-- ROLLBACK
--   None needed: the browser roles held nothing before.

do $$
declare
  v_priv text;
begin
  set local lock_timeout = '5s';

  if to_regclass('public.phoenix_crm_rep_entry_days_cache') is null then
    raise notice 'public.phoenix_crm_rep_entry_days_cache does not exist here - skipped';
    return;
  end if;

  revoke all on table public.phoenix_crm_rep_entry_days_cache from public, anon, authenticated;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('anon', 'public.phoenix_crm_rep_entry_days_cache', v_priv) then
      raise exception 'refusing: anon still holds % on public.phoenix_crm_rep_entry_days_cache', v_priv;
    end if;
    if has_table_privilege('authenticated', 'public.phoenix_crm_rep_entry_days_cache', v_priv) then
      raise exception 'refusing: authenticated still holds % on public.phoenix_crm_rep_entry_days_cache', v_priv;
    end if;
  end loop;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.phoenix_crm_rep_entry_days_cache'::regclass) then
    raise exception 'refusing: row level security is OFF on public.phoenix_crm_rep_entry_days_cache';
  end if;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.phoenix_crm_rep_entry_days_cache', v_priv) then
      raise exception 'refusing: service_role lost % on public.phoenix_crm_rep_entry_days_cache', v_priv;
    end if;
  end loop;

  raise notice 'public.phoenix_crm_rep_entry_days_cache is revoked from public, anon and authenticated';
end
$$;
