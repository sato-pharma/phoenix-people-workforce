-- public.deductions_categories becomes server-only: no browser grant, no open policy.
--
-- WHAT (audit 2026-10-26, point 12 — measured live on production and staging)
--   `authenticated` held the full privilege set (arwdDxtm) on this table, row security was on, and
--   its one policy, deductions_categories_authenticated_select, was `using (true)` for SELECT. So any
--   signed-in browser could read every category directly with the public key, and held INSERT,
--   UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER grants that only row security (and, for
--   TRUNCATE, nothing at all) stood in front of. It was the one entry on the open-policy allowlist in
--   scripts/check-schema-shape.ts.
--
-- WHY IT IS SAFE
--   - No app code reads the table: src/ and app/ name it once, in a comment
--     (src/lib/deductions/calculations.ts keeps a static mirror of its seed rows). No database
--     function body names it (pg_proc, 2026-10-26: 0), and no view depends on it.
--   - Five foreign keys reference it; their checks run as the table owner, not as the querying role,
--     so taking the browser roles' grants away does not affect a single insert elsewhere.
--   - service_role keeps every privilege (asserted below).
--
-- WHAT IT CHANGES IN THE CHECKS
--   Row security stays on and the table now has no policy, the deny-all shape the advisor reports as
--   rls_enabled_no_policy (+1, carried in scripts/advisor-baseline.json). The open-policy allowlist in
--   scripts/check-schema-shape.ts is now EMPTY, so an open `using (true)` policy anywhere fails the
--   schema-shape check again.
--
-- RE-APPLY / OTHER DATABASES
--   `drop policy if exists` and revoking a privilege not held are both no-ops, so this is safe twice;
--   a database without the table skips it with a notice. RAISES if a browser role still holds any
--   privilege, if the open policy survived, if row security is off, or if service_role lost one.
--
-- ROLLBACK
--   create policy deductions_categories_authenticated_select on public.deductions_categories
--     for select to authenticated using (true);
--   grant select on public.deductions_categories to authenticated;

do $$
declare
  v_priv text;
begin
  set local lock_timeout = '5s';

  if to_regclass('public.deductions_categories') is null then
    raise notice 'public.deductions_categories does not exist here - skipped';
    return;
  end if;

  drop policy if exists deductions_categories_authenticated_select on public.deductions_categories;
  revoke all on table public.deductions_categories from public, anon, authenticated;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('anon', 'public.deductions_categories', v_priv) then
      raise exception 'refusing: anon still holds % on public.deductions_categories', v_priv;
    end if;
    if has_table_privilege('authenticated', 'public.deductions_categories', v_priv) then
      raise exception 'refusing: authenticated still holds % on public.deductions_categories', v_priv;
    end if;
  end loop;

  if exists (
    select 1 from pg_policy p
    where p.polrelid = 'public.deductions_categories'::regclass
      and p.polname = 'deductions_categories_authenticated_select'
  ) then
    raise exception 'refusing: the open select policy on public.deductions_categories survived';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.deductions_categories'::regclass) then
    raise exception 'refusing: row level security is OFF on public.deductions_categories';
  end if;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.deductions_categories', v_priv) then
      raise exception 'refusing: service_role lost % on public.deductions_categories', v_priv;
    end if;
  end loop;

  raise notice 'public.deductions_categories is server-only';
end
$$;
