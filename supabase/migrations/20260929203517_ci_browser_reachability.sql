-- What a BROWSER role can actually reach in `public`, read from the live catalogue.
--
-- Visibility in this app is application-scoped: almost every code path uses the service-role
-- client and `assertPermission` is the real boundary. RLS is the backstop for the one thing the
-- application cannot control — the `anon` key, which is public by design and hardcoded in
-- ci.yml on the explicit justification that it is "RLS-protected".
--
-- check-schema-shape.ts already fails a table that is GRANTED to a browser role while RLS is
-- DISABLED. Measured on production 2026-09-29 that set is empty, and so are the obvious
-- neighbours: 429 tables, `anon` can SELECT **0** of them; the 6 RLS-disabled tables carry no
-- browser grant at all.
--
-- 🔴 BUT "RLS IS ENABLED" IS NOT THE SAME AS "A BROWSER CANNOT READ IT", AND TWO WAYS THROUGH
-- ARE INVISIBLE TO EVERY CHECK IN THIS REPO TODAY:
--
--   1. A PERMISSIVE `true` SELECT POLICY for anon / authenticated / PUBLIC. RLS reads as
--      ENABLED, the table has a policy, every existing count is green — and the table is wide
--      open to that role. One is live right now: public.deductions_categories, readable by any
--      logged-in user.
--
--   2. A GRANTED VIEW THAT IS NOT `security_invoker`. A view runs as its OWNER by default, so
--      it reads straight past the RLS of every table underneath it — the grant on the view is
--      the only gate, and the underlying policies never run. Eleven views in `public` carry a
--      browser grant; all eleven are `security_invoker = true` today, which is the only reason
--      this is not already a breach. A MATERIALIZED view cannot be security_invoker at all and
--      has no RLS of its own, so a granted one is always a straight bypass.
--
--      `security_invoker` IS checked in this repo — but only as TEXT INSIDE MIGRATION FILES
--      (scripts/security-rls-static.ts, scripts/lib/migration-inventory.ts). Nothing has ever
--      asked the live database. A view created by hand, or restored from a backup, or altered
--      with `alter view ... reset (security_invoker)`, passes every one of those greps.
--
-- This function answers both from pg_catalog, for the daily check to compare against an
-- explicit, reasoned allowlist. It returns ONLY relations a browser role is granted on — about
-- eighty rows — so the allowlist stays something a human can actually read.
--
-- It reports; it decides nothing. The verdict and the allowlist live in
-- scripts/check-schema-shape.ts so that changing what is tolerated is a reviewable diff.

create or replace function public.phx_ci_browser_reachability()
returns table (
  relname          text,
  relkind          text,
  anon_select      boolean,
  auth_select      boolean,
  rls_enabled      boolean,
  policy_count     integer,
  security_invoker boolean,
  open_policy      text
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select
    c.relname::text,
    (case c.relkind
       when 'r' then 'table'  when 'p' then 'partitioned'
       when 'v' then 'view'   when 'm' then 'matview'
       else c.relkind::text end)::text,
    pg_catalog.has_table_privilege('anon', c.oid, 'SELECT'),
    pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'),
    c.relrowsecurity,
    (select count(*)::integer from pg_catalog.pg_policy p where p.polrelid = c.oid),
    -- A table has no security_invoker option; report NULL rather than a misleading false.
    (case when c.relkind in ('v', 'm')
          then coalesce(c.reloptions::text[] @> array['security_invoker=true']
                     or c.reloptions::text[] @> array['security_invoker=on'], false)
          else null end),
    -- Roles holding a PERMISSIVE read policy whose USING clause is literally `true`, i.e. a
    -- policy that filters nothing. `polroles = {0}` is PUBLIC, which reaches every role.
    (select string_agg(distinct r.who, ',' order by r.who)
       from (
         select case when p.polroles = '{0}'::oid[] then 'PUBLIC'
                     else (select rl.rolname::text from pg_catalog.pg_roles rl
                            where rl.oid = any(p.polroles)
                              and rl.rolname in ('anon', 'authenticated')
                            limit 1) end as who
           from pg_catalog.pg_policy p
          where p.polrelid = c.oid
            and p.polpermissive
            and p.polcmd in ('r', '*')
            and (p.polqual is null
                 or pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ '^[[:space:]]*true[[:space:]]*$')
            and (p.polroles = '{0}'::oid[]
                 or p.polroles && array(select rl2.oid from pg_catalog.pg_roles rl2
                                         where rl2.rolname in ('anon', 'authenticated')))
       ) r
      where r.who is not null)::text
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
    and (pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'))
  order by c.relname;
$function$;

comment on function public.phx_ci_browser_reachability() is
  'Per-relation browser reachability in public, for the daily schema-shape check. Reports only '
  'relations granted to anon or authenticated. Two facts nothing else in this repo reads from '
  'the LIVE database: a permissive `true` read policy, and a granted view that is not '
  'security_invoker. Reports only — the allowlist and the verdict live in check-schema-shape.ts.';

revoke execute on function public.phx_ci_browser_reachability() from public, anon, authenticated;
grant execute on function public.phx_ci_browser_reachability() to service_role;
