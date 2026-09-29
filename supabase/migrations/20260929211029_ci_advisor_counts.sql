-- Reproduce the Supabase advisor's counts from pg_catalog, so CI can gate on them.
--
-- WHY THIS EXISTS. docs/security/supabase-advisor-baseline.md is the triage reference that says
-- which advisor findings are accepted as by-design. It was last reviewed 2026-07-19 and its
-- numbers had rotted badly by 2026-09-29:
--
--     rls_enabled_no_policy        baseline said INFO x23      live: 176
--     unused_index                 baseline said INFO x326      live: 615
--     function_search_path_mutable baseline said REMEDIATED     live: 10
--
-- That last one matters most. The baseline states in its own words that if
-- `function_search_path_mutable` reappears "it's a regression" — and it had, ten times over,
-- for none of the functions it named. Nobody saw it, because nothing compares the live advisor
-- output to that document. A triage reference that is never checked stops being a reference and
-- becomes a story about the past: 153 tables joined an "accepted" list with nobody accepting
-- them.
--
-- 🔴 THE ADVISOR ITSELF CANNOT DO THIS JOB. `get_advisors` is a Supabase MCP tool; CI has no
-- MCP. So the counts are recomputed here in SQL, and the definitions below were validated
-- against a live `get_advisors` run on production on 2026-09-29 until they matched EXACTLY.
-- Two did not match at first, and both differences turned out to be real exclusions the advisor
-- makes and a naive query does not:
--
--   * function_search_path_mutable — a naive count returns 41. THIRTY-ONE of those belong to
--     the `pg_trgm` extension, which does not set search_path on its own functions and is not
--     the project's to fix. Excluding extension-owned functions gives 10, the advisor's number.
--     Without that exclusion the gate would be permanently 31 over its own baseline, which is
--     how a check gets switched off.
--
--   * rls_enabled_no_policy — a naive count returns 200. The 24-table difference is exactly
--     `auth` (16) + `storage` (7) + `realtime` (1): Supabase-managed schemas, whose RLS posture
--     is the platform's business. Excluding them gives 176, the advisor's number.
--
-- `unused_index` is the one category whose definition is OURS rather than the advisor's — the
-- advisor's own output for it is ~615 findings, too large to pull routinely. The definition is
-- written out in full below so the number means something specific, and
-- docs/security/supabase-advisor-baseline.md says so plainly rather than implying the advisor
-- blessed it.
--
-- 🔴 A COUNT IS NOT A VERDICT. This reports; scripts/check-advisor-baseline.ts compares against
-- the recorded baseline and decides. Growth in a category must force a decision instead of
-- accruing silently — that is the whole failure this closes.

create or replace function public.phx_ci_advisor_counts()
returns table (category text, current_count integer)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  -- RLS enabled with no policy. Deny-all, and deliberate here: the owner's standing decision is
  -- that RLS stays application-first. Excludes Supabase-managed schemas (see header).
  select 'rls_enabled_no_policy'::text, count(*)::integer
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and c.relrowsecurity
     and (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) = 0
     and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast',
                           'auth', 'storage', 'realtime', 'vault', 'extensions',
                           'graphql', 'graphql_public', 'cron', 'net', 'supabase_migrations')
     and n.nspname not like 'pg\_%'
     and n.nspname not like 'pgsodium%'
     and n.nspname not like 'supabase\_%'

  union all

  -- A function with no pinned search_path can be hijacked by a caller's search_path. Extension
  -- functions are excluded: 31 of pg_trgm's are unpinned and are not this project's to fix.
  select 'function_search_path_mutable', count(*)::integer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
                      where cfg like 'search_path=%')
     and not exists (select 1 from pg_catalog.pg_depend d
                      where d.objid = p.oid
                        and d.classid = 'pg_proc'::regclass
                        and d.deptype = 'e')

  union all

  select 'extension_in_public', count(*)::integer
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where n.nspname = 'public'

  union all

  -- SECURITY DEFINER functions any signed-in user can call over REST.
  select 'authenticated_security_definer_function_executable', count(*)::integer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')

  union all

  -- OUR definition, not the advisor's: an index never scanned since the last stats reset, that
  -- is not unique, not a primary key, and does not back a constraint. 🔴 It is NOT a drop list —
  -- pg_stat counters reset with the postmaster and never observe a low-frequency path such as
  -- the daily birthday cron. It is here so GROWTH is visible.
  select 'unused_index', count(*)::integer
    from pg_catalog.pg_stat_user_indexes s
    join pg_catalog.pg_index i on i.indexrelid = s.indexrelid
   where s.idx_scan = 0
     and not i.indisunique
     and not i.indisprimary
     and not exists (select 1 from pg_catalog.pg_constraint ct where ct.conindid = i.indexrelid)

  union all

  -- Not an advisor category. Recorded alongside them because "unused" above is meaningless
  -- without knowing how long the counters have been running: a reset makes every index look
  -- unused, and reading that as a drop list is the trap the baseline doc already warns about.
  select 'stats_age_hours',
         coalesce(extract(epoch from (now() - s.stats_reset)) / 3600, -1)::integer
    from pg_catalog.pg_stat_database s
   where s.datname = current_database();
$function$;

comment on function public.phx_ci_advisor_counts() is
  'Supabase advisor categories recomputed from pg_catalog so CI can gate on them without the '
  'MCP get_advisors tool. Validated to match a live advisor run exactly on 2026-09-29 '
  '(rls_enabled_no_policy 176, function_search_path_mutable 10, extension_in_public 1, '
  'authenticated_security_definer_function_executable 14); unused_index uses our own stated '
  'definition. Reports only — scripts/check-advisor-baseline.ts holds the baseline and decides.';

revoke execute on function public.phx_ci_advisor_counts() from public, anon, authenticated;
grant execute on function public.phx_ci_advisor_counts() to service_role;
